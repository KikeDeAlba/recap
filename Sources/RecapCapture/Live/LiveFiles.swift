import Darwin
import Foundation

package enum LiveFiles {
    package static let directoryName = "live"
    package static let chunksDirectoryName = "chunks"

    package static func dir(_ meetingDir: URL) -> URL { meetingDir.appending(path: directoryName) }
    package static func chunks(_ meetingDir: URL) -> URL { dir(meetingDir).appending(path: chunksDirectoryName) }
    package static func chunkIndex(_ meetingDir: URL) -> URL { chunks(meetingDir).appending(path: "index.jsonl") }
    package static func transcript(_ meetingDir: URL) -> URL { dir(meetingDir).appending(path: "transcript.jsonl") }
    package static func answers(_ meetingDir: URL) -> URL { dir(meetingDir).appending(path: "answers.jsonl") }
    package static func workerLock(_ meetingDir: URL) -> URL { dir(meetingDir).appending(path: "worker.pid") }
    package static func workerState(_ meetingDir: URL) -> URL { dir(meetingDir).appending(path: "worker-state.json") }
    package static func detectorState(_ meetingDir: URL) -> URL { dir(meetingDir).appending(path: "detector-state.json") }
    package static func asking(_ meetingDir: URL) -> URL { dir(meetingDir).appending(path: "asking.json") }
    package static func askingDir(_ meetingDir: URL) -> URL { dir(meetingDir).appending(path: "asking") }
    package static func workerLog(_ meetingDir: URL) -> URL { dir(meetingDir).appending(path: "worker.log") }

    package static func chunkFileName(channel: Channel, seq: Int) -> String {
        String(format: "%@-%05d.wav", channel.rawValue, seq)
    }
}

package struct ChunkIndexEntry: Codable, Equatable {
    package var file: String?
    package var channel: Channel
    package var seq: Int
    package var startMs: Int
    package var endMs: Int

    package init(file: String?, channel: Channel, seq: Int, startMs: Int, endMs: Int) {
        self.file = file
        self.channel = channel
        self.seq = seq
        self.startMs = startMs
        self.endMs = endMs
    }
}

package enum JSONLines {
    package static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()

    package static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()

    package static func line<T: Encodable>(_ value: T) throws -> String {
        String(decoding: try encoder.encode(value), as: UTF8.self)
    }

    package static func append<T: Encodable>(_ values: [T], to url: URL) throws {
        guard !values.isEmpty else { return }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let text = try values.map { try line($0) + "\n" }.joined()
        let descriptor = open(url.path, O_WRONLY | O_APPEND | O_CREAT, 0o644)
        guard descriptor >= 0 else {
            throw RecapError("WRITE_FAILED", "Cannot open \(url.path): \(String(cString: strerror(errno)))")
        }
        defer { close(descriptor) }
        let data = Data(text.utf8)
        let written = data.withUnsafeBytes { write(descriptor, $0.baseAddress, $0.count) }
        guard written == data.count else {
            throw RecapError("WRITE_FAILED", "Cannot append to \(url.path)")
        }
    }

    package static func read<T: Decodable>(_ type: T.Type, from url: URL) -> [T] {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return [] }
        return parse(type, text)
    }

    package static func parse<T: Decodable>(_ type: T.Type, _ text: String) -> [T] {
        text.split(separator: "\n", omittingEmptySubsequences: true).compactMap { line in
            try? decoder.decode(T.self, from: Data(line.utf8))
        }
    }
}

package enum WavFile {
    package static func encode(_ samples: [Float], sampleRate: Int) -> Data {
        var data = Data()
        let dataBytes = samples.count * 2
        func append<T: FixedWidthInteger>(_ value: T) {
            var little = value.littleEndian
            withUnsafeBytes(of: &little) { data.append(contentsOf: $0) }
        }
        data.append(contentsOf: Array("RIFF".utf8))
        append(UInt32(36 + dataBytes))
        data.append(contentsOf: Array("WAVE".utf8))
        data.append(contentsOf: Array("fmt ".utf8))
        append(UInt32(16))
        append(UInt16(1))
        append(UInt16(1))
        append(UInt32(sampleRate))
        append(UInt32(sampleRate * 2))
        append(UInt16(2))
        append(UInt16(16))
        data.append(contentsOf: Array("data".utf8))
        append(UInt32(dataBytes))
        data.reserveCapacity(data.count + dataBytes)
        for sample in samples {
            let clamped = max(-1, min(1, sample.isFinite ? sample : 0))
            append(Int16((clamped * Float(Int16.max)).rounded()))
        }
        return data
    }

    package static func writeAtomically(_ samples: [Float], sampleRate: Int, to url: URL) throws {
        let temporary = url.deletingLastPathComponent().appending(path: ".\(url.lastPathComponent).tmp")
        try encode(samples, sampleRate: sampleRate).write(to: temporary)
        guard rename(temporary.path, url.path) == 0 else {
            try? FileManager.default.removeItem(at: temporary)
            throw RecapError("WRITE_FAILED", "Cannot move \(temporary.lastPathComponent) to \(url.lastPathComponent)")
        }
    }
}
