import Darwin
import Foundation

enum LiveFiles {
    static let directoryName = "live"
    static let chunksDirectoryName = "chunks"

    static func dir(_ meetingDir: URL) -> URL { meetingDir.appending(path: directoryName) }
    static func chunks(_ meetingDir: URL) -> URL { dir(meetingDir).appending(path: chunksDirectoryName) }
    static func chunkIndex(_ meetingDir: URL) -> URL { chunks(meetingDir).appending(path: "index.jsonl") }
    static func transcript(_ meetingDir: URL) -> URL { dir(meetingDir).appending(path: "transcript.jsonl") }
    static func answers(_ meetingDir: URL) -> URL { dir(meetingDir).appending(path: "answers.jsonl") }
    static func workerLock(_ meetingDir: URL) -> URL { dir(meetingDir).appending(path: "worker.pid") }
    static func workerState(_ meetingDir: URL) -> URL { dir(meetingDir).appending(path: "worker-state.json") }
    static func workerLog(_ meetingDir: URL) -> URL { dir(meetingDir).appending(path: "worker.log") }
}

struct ChunkIndexEntry: Codable, Equatable {
    var file: String?
    var channel: Channel
    var seq: Int
    var startMs: Int
    var endMs: Int
}

enum JSONLines {
    static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()

    static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()

    static func line<T: Encodable>(_ value: T) throws -> String {
        String(decoding: try encoder.encode(value), as: UTF8.self)
    }

    static func append<T: Encodable>(_ values: [T], to url: URL) throws {
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

    static func read<T: Decodable>(_ type: T.Type, from url: URL) -> [T] {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return [] }
        return parse(type, text)
    }

    static func parse<T: Decodable>(_ type: T.Type, _ text: String) -> [T] {
        text.split(separator: "\n", omittingEmptySubsequences: true).compactMap { line in
            try? decoder.decode(T.self, from: Data(line.utf8))
        }
    }
}

enum WavFile {
    static func encode(_ samples: [Float], sampleRate: Int) -> Data {
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

    static func writeAtomically(_ samples: [Float], sampleRate: Int, to url: URL) throws {
        let temporary = url.deletingLastPathComponent().appending(path: ".\(url.lastPathComponent).tmp")
        try encode(samples, sampleRate: sampleRate).write(to: temporary)
        guard rename(temporary.path, url.path) == 0 else {
            try? FileManager.default.removeItem(at: temporary)
            throw RecapError("WRITE_FAILED", "Cannot move \(temporary.lastPathComponent) to \(url.lastPathComponent)")
        }
    }
}
