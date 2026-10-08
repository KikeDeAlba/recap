import ArgumentParser
import Foundation

enum MeetingTarget {
    static func resolve(_ store: MeetingStore, reference: String?, bitaEntryId: Int?) throws -> (Meeting, URL) {
        if let bitaEntryId {
            guard let found = store.find(bitaEntryId: bitaEntryId) else {
                throw RecapError("MEETING_NOT_FOUND", "No meeting is linked to bita entry \(bitaEntryId)")
            }
            return found
        }
        guard let reference else {
            throw RecapError("MEETING_REQUIRED", "Pass the meeting id, a unique part of it, \"last\" or --bita-entry")
        }
        return try store.resolve(reference)
    }
}

struct StripVideoCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "strip-video",
        abstract: "Remove the video of a remote meeting and keep both audio tracks in recording.m4a."
    )

    @Argument(help: "Meeting id, a unique part of it, or \"last\".")
    var meeting: String?

    @Option(name: .customLong("bita-entry"), help: "Use the meeting linked to this bita entry.")
    var bitaEntry: Int?

    @Flag(name: .customLong("prune-intermediates"), help: "Also delete mic.wav, system.wav, the per-channel transcripts and the live chunks.")
    var pruneIntermediates = false

    @OptionGroup var output: OutputOptions

    func run() throws {
        try Output.run("strip-video", json: output.json) {
            let config = try Config.load()
            let (found, dir) = try MeetingTarget.resolve(MeetingStore(config: config), reference: meeting, bitaEntryId: bitaEntry)
            let before = MeetingMedia.size(dir)
            let updated = try MediaOperations(config: config).stripVideo(meeting: found, dir: dir, pruneIntermediates: pruneIntermediates)
            let record = MeetingRecord(meeting: updated, dir: dir)
            return (record, "Removed the video from \"\(updated.title)\": \(Bytes.format(before)) -> \(Bytes.format(MeetingMedia.size(dir)))")
        }
    }
}

struct CompressVideoCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "compress-video",
        abstract: "Re-encode the video of a remote meeting with HEVC to save space."
    )

    @Argument(help: "Meeting id, a unique part of it, or \"last\".")
    var meeting: String?

    @Option(name: .customLong("bita-entry"), help: "Use the meeting linked to this bita entry.")
    var bitaEntry: Int?

    @Option(help: "Compression level (\(VideoPreset.allCases.map(\.rawValue).joined(separator: ", "))).")
    var preset: VideoPreset

    @Flag(name: .customLong("prune-intermediates"), help: "Also delete mic.wav, system.wav, the per-channel transcripts and the live chunks.")
    var pruneIntermediates = false

    @OptionGroup var output: OutputOptions

    func run() throws {
        try Output.run("compress-video", json: output.json) {
            let config = try Config.load()
            let (found, dir) = try MeetingTarget.resolve(MeetingStore(config: config), reference: meeting, bitaEntryId: bitaEntry)
            let before = MeetingMedia.size(dir)
            let updated = try MediaOperations(config: config).compressVideo(meeting: found, dir: dir, preset: preset,
                                                                            pruneIntermediates: pruneIntermediates)
            let record = MeetingRecord(meeting: updated, dir: dir)
            return (record, "Compressed the video of \"\(updated.title)\" (\(preset.rawValue)): \(Bytes.format(before)) -> \(Bytes.format(MeetingMedia.size(dir)))")
        }
    }
}

struct PruneCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "prune",
        abstract: "Delete files of a meeting that can be regenerated."
    )

    @Argument(help: "Meeting id, a unique part of it, or \"last\".")
    var meeting: String?

    @Option(name: .customLong("bita-entry"), help: "Use the meeting linked to this bita entry.")
    var bitaEntry: Int?

    @Flag(help: "Delete mic.wav, system.wav, the per-channel transcripts and the live chunks.")
    var intermediates = false

    @OptionGroup var output: OutputOptions

    func validate() throws {
        guard intermediates else { throw ValidationError("Choose what to prune: --intermediates") }
    }

    func run() throws {
        try Output.run("prune", json: output.json) {
            let config = try Config.load()
            let (found, dir) = try MeetingTarget.resolve(MeetingStore(config: config), reference: meeting, bitaEntryId: bitaEntry)
            let before = MeetingMedia.size(dir)
            let updated = try MediaOperations(config: config).prune(meeting: found, dir: dir)
            let record = MeetingRecord(meeting: updated, dir: dir)
            return (record, "Pruned \"\(updated.title)\": \(Bytes.format(before)) -> \(Bytes.format(MeetingMedia.size(dir)))")
        }
    }
}

struct DeleteCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "delete",
        abstract: "Delete a meeting that is not being recorded or processed, with all its files."
    )

    @Argument(help: "Meeting id, a unique part of it, or \"last\".")
    var meeting: String?

    @Option(name: .customLong("bita-entry"), help: "Use the meeting linked to this bita entry.")
    var bitaEntry: Int?

    @OptionGroup var output: OutputOptions

    func run() throws {
        try Output.run("delete", json: output.json) {
            let config = try Config.load()
            let (found, dir) = try MeetingTarget.resolve(MeetingStore(config: config), reference: meeting, bitaEntryId: bitaEntry)
            let deleted = try MediaOperations.delete(meeting: found, dir: dir)
            return (deleted, "Deleted \"\(found.title)\", freed \(Bytes.format(deleted.freedBytes))")
        }
    }
}
