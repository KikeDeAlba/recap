use std::io::{self, Read, Write};
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;

#[cfg(windows)]
mod capture;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    System,
    Mic,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Options {
    pub source: Source,
    pub rate: u32,
    pub channels: u16,
}

pub const USAGE: &str = "usage: recap-loopback --source system|mic [--rate 48000] [--channels n]";

pub fn parse_args(args: &[String]) -> Result<Options, String> {
    let mut source = None;
    let mut rate = 48_000u32;
    let mut channels = None;
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        let mut value = |name: &str| {
            iter.next()
                .cloned()
                .ok_or_else(|| format!("{name} needs a value"))
        };
        match arg.as_str() {
            "--source" => {
                source = Some(match value("--source")?.as_str() {
                    "system" => Source::System,
                    "mic" => Source::Mic,
                    other => return Err(format!("unknown source {other}")),
                })
            }
            "--rate" => {
                rate = value("--rate")?
                    .parse()
                    .map_err(|_| "--rate must be a number".to_string())?
            }
            "--channels" => {
                channels = Some(
                    value("--channels")?
                        .parse()
                        .map_err(|_| "--channels must be a number".to_string())?,
                )
            }
            other => return Err(format!("unknown argument {other}")),
        }
    }
    let source = source.ok_or_else(|| "--source is required".to_string())?;
    if !(8_000..=192_000).contains(&rate) {
        return Err("--rate must be between 8000 and 192000".to_string());
    }
    let channels = channels.unwrap_or(match source {
        Source::System => 2,
        Source::Mic => 1,
    });
    if !(1..=8).contains(&channels) {
        return Err("--channels must be between 1 and 8".to_string());
    }
    Ok(Options {
        source,
        rate,
        channels,
    })
}

fn json_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

pub fn started_event(channels: u16, rate: u32) -> String {
    format!("{{\"event\":\"started\",\"channels\":{channels},\"rate\":{rate}}}")
}

pub fn stopped_event(frames: u64) -> String {
    format!("{{\"event\":\"stopped\",\"frames\":{frames}}}")
}

pub fn error_event(message: &str) -> String {
    format!(
        "{{\"event\":\"error\",\"message\":{}}}",
        json_string(message)
    )
}

pub fn silence_frames(elapsed_ms: u64, rate: u32, produced: u64) -> u64 {
    let expected = elapsed_ms * u64::from(rate) / 1000;
    expected.saturating_sub(produced)
}

pub fn emit(line: &str) {
    let mut stderr = io::stderr().lock();
    let _ = writeln!(stderr, "{line}");
    let _ = stderr.flush();
}

pub fn watch_stdin(stop: Arc<AtomicBool>) {
    thread::spawn(move || {
        let mut stdin = io::stdin().lock();
        let mut byte = [0u8; 1];
        loop {
            match stdin.read(&mut byte) {
                Ok(0) | Err(_) => break,
                Ok(_) if byte[0] == b'q' || byte[0] == b'Q' => break,
                Ok(_) => continue,
            }
        }
        stop.store(true, Ordering::SeqCst);
    });
}

#[cfg(windows)]
fn run(options: Options, stop: Arc<AtomicBool>) -> Result<u64, String> {
    capture::run(options, stop)
}

#[cfg(not(windows))]
fn run(_options: Options, _stop: Arc<AtomicBool>) -> Result<u64, String> {
    Err("recap-loopback only captures audio on Windows".to_string())
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        println!("{USAGE}");
        return ExitCode::SUCCESS;
    }
    if args.iter().any(|arg| arg == "--version") {
        println!("{}", env!("CARGO_PKG_VERSION"));
        return ExitCode::SUCCESS;
    }
    let options = match parse_args(&args) {
        Ok(options) => options,
        Err(message) => {
            emit(&error_event(&format!("{message}; {USAGE}")));
            return ExitCode::from(2);
        }
    };
    let stop = Arc::new(AtomicBool::new(false));
    watch_stdin(stop.clone());
    match run(options, stop) {
        Ok(frames) => {
            emit(&stopped_event(frames));
            ExitCode::SUCCESS
        }
        Err(message) => {
            emit(&error_event(&message));
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|item| item.to_string()).collect()
    }

    #[test]
    fn parses_the_source_with_its_default_layout() {
        assert_eq!(
            parse_args(&args(&["--source", "system"])),
            Ok(Options {
                source: Source::System,
                rate: 48_000,
                channels: 2
            })
        );
        assert_eq!(
            parse_args(&args(&["--source", "mic", "--rate", "44100"])),
            Ok(Options {
                source: Source::Mic,
                rate: 44_100,
                channels: 1
            })
        );
    }

    #[test]
    fn rejects_bad_arguments() {
        assert!(parse_args(&args(&[])).is_err());
        assert!(parse_args(&args(&["--source", "speaker"])).is_err());
        assert!(parse_args(&args(&["--source", "mic", "--rate", "10"])).is_err());
        assert!(parse_args(&args(&["--source", "mic", "--extra"])).is_err());
        assert!(parse_args(&args(&["--source"])).is_err());
    }

    #[test]
    fn writes_the_events_as_json_lines() {
        assert_eq!(
            started_event(2, 48_000),
            r#"{"event":"started","channels":2,"rate":48000}"#
        );
        assert_eq!(stopped_event(9), r#"{"event":"stopped","frames":9}"#);
        assert_eq!(
            error_event("bad \"x\"\n"),
            r#"{"event":"error","message":"bad \"x\"\n"}"#
        );
    }

    #[test]
    fn pads_only_the_missing_frames() {
        assert_eq!(silence_frames(1_000, 48_000, 0), 48_000);
        assert_eq!(silence_frames(1_000, 48_000, 47_000), 1_000);
        assert_eq!(silence_frames(1_000, 48_000, 50_000), 0);
    }
}
