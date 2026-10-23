use std::collections::VecDeque;
use std::io::{self, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use wasapi::{initialize_mta, DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat};

use crate::{emit, silence_frames, started_event, Options, Source};

const WAIT_MS: u32 = 100;
const SILENCE_LAG_MS: u64 = 200;

fn fail<E: std::fmt::Display>(context: &str) -> impl FnOnce(E) -> String + '_ {
    move |error| format!("{context}: {error}")
}

pub fn run(options: Options, stop: Arc<AtomicBool>) -> Result<u64, String> {
    initialize_mta()
        .ok()
        .map_err(fail("cannot initialize COM"))?;
    let enumerator = DeviceEnumerator::new().map_err(fail("cannot list the audio devices"))?;
    let endpoint = match options.source {
        Source::System => Direction::Render,
        Source::Mic => Direction::Capture,
    };
    let device = enumerator
        .get_default_device(&endpoint)
        .map_err(fail("there is no default audio device"))?;
    let mut client = device
        .get_iaudioclient()
        .map_err(fail("cannot open the audio device"))?;
    let format = WaveFormat::new(
        16,
        16,
        &SampleType::Int,
        options.rate as usize,
        options.channels as usize,
        None,
    );
    let block = format.get_blockalign() as usize;
    let (default_period, _) = client
        .get_device_period()
        .map_err(fail("cannot read the device period"))?;
    let mode = StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: default_period * 4,
    };
    client
        .initialize_client(&format, &Direction::Capture, &mode)
        .map_err(fail("cannot start the capture stream"))?;
    let event = client
        .set_get_eventhandle()
        .map_err(fail("cannot create the capture event"))?;
    let capture = client
        .get_audiocaptureclient()
        .map_err(fail("cannot open the capture client"))?;
    let mut queue: VecDeque<u8> = VecDeque::with_capacity(block * options.rate as usize);
    let mut stdout = io::stdout().lock();
    client
        .start_stream()
        .map_err(fail("cannot start the capture stream"))?;
    emit(&started_event(options.channels, options.rate));
    let started = Instant::now();
    let mut produced: u64 = 0;
    let mut result = Ok(());
    while !stop.load(Ordering::SeqCst) {
        let signaled = event.wait_for_event(WAIT_MS).is_ok();
        loop {
            match capture.get_next_packet_size() {
                Ok(Some(0)) | Ok(None) => break,
                Ok(Some(_)) => {
                    if let Err(error) = capture.read_from_device_to_deque(&mut queue) {
                        result = Err(format!("capture failed: {error}"));
                        break;
                    }
                }
                Err(error) => {
                    result = Err(format!("capture failed: {error}"));
                    break;
                }
            }
        }
        if result.is_err() {
            break;
        }
        let elapsed = started.elapsed().as_millis() as u64;
        let available = (queue.len() / block) as u64;
        if !signaled && available == 0 {
            let missing = silence_frames(
                elapsed.saturating_sub(SILENCE_LAG_MS),
                options.rate,
                produced,
            );
            if missing > 0 {
                queue.extend(std::iter::repeat_n(0u8, missing as usize * block));
            }
        }
        let frames = queue.len() / block;
        if frames == 0 {
            continue;
        }
        let bytes = frames * block;
        let (front, back) = queue.as_slices();
        let first = front.len().min(bytes);
        let written = stdout
            .write_all(&front[..first])
            .and_then(|_| stdout.write_all(&back[..bytes - first]))
            .and_then(|_| stdout.flush());
        queue.drain(..bytes);
        produced += frames as u64;
        if written.is_err() {
            break;
        }
    }
    let _ = client.stop_stream();
    result.map(|_| produced)
}
