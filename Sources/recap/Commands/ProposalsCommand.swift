import ArgumentParser
import Foundation

struct ProposalsCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "proposals",
        abstract: "Review the documentation changes proposed from a meeting.",
        subcommands: [ProposalsListCommand.self, ProposalsShowCommand.self, ProposalsAcceptCommand.self, ProposalsRejectCommand.self]
    )
}

struct ProposalTarget: ParsableArguments {
    @Argument(help: "Meeting id (or a unique part of it), then the proposal number when the command takes one.")
    var values: [String] = []

    @Option(name: .customLong("bita-entry"), help: "Use the meeting linked to this bita entry instead of a meeting id.")
    var bitaEntry: Int?

    func meeting(_ config: Config) throws -> (Meeting, URL) {
        try MeetingTarget.resolve(MeetingStore(config: config), reference: bitaEntry == nil ? values.first : nil, bitaEntryId: bitaEntry)
    }

    func number() throws -> Int {
        let raw = bitaEntry == nil ? values.dropFirst().first : values.first
        guard let raw, let n = Int(raw) else {
            throw RecapError("PROPOSAL_REQUIRED", "Pass the proposal number")
        }
        return n
    }

    func review(_ config: Config) throws -> (Meeting, URL, ProposalReview) {
        let (meeting, dir) = try meeting(config)
        guard let bita = MeetingContext.bita(meeting, config: config) else {
            throw RecapError("DEPENDENCY_MISSING", "bita not found. Install it with `\(Tool.bita.installHint)`")
        }
        return (meeting, dir, ProposalReview(dir: dir, bita: bita))
    }
}

struct ProposalsData: Encodable {
    let proposals: [Proposal]
}

struct ProposalData: Encodable {
    let proposal: Proposal
}

struct ProposalDetail: Encodable {
    let proposal: Proposal
    let markdown: String?
    let diff: JSONValue?
}

enum ProposalText {
    static func line(_ proposal: Proposal) -> String {
        let section = proposal.section.map { " › \($0)" } ?? ""
        return "\(proposal.n). [\(proposal.status.rawValue)] \(proposal.pageTitle)\(section): \(proposal.title)"
    }
}

struct ProposalsListCommand: ParsableCommand {
    static let configuration = CommandConfiguration(commandName: "ls", abstract: "List the proposals of a meeting.")

    @OptionGroup var target: ProposalTarget
    @OptionGroup var output: OutputOptions

    func run() throws {
        try Output.run("proposals ls", json: output.json) {
            let config = try Config.load()
            let (_, dir) = try target.meeting(config)
            let proposals = ProposalStore.load(dir)?.proposals ?? []
            let text = proposals.isEmpty ? "No proposals" : proposals.map(ProposalText.line).joined(separator: "\n")
            return (ProposalsData(proposals: proposals), text)
        }
    }
}

struct ProposalsShowCommand: ParsableCommand {
    static let configuration = CommandConfiguration(commandName: "show", abstract: "Show one proposal with its markdown and diff.")

    @OptionGroup var target: ProposalTarget
    @OptionGroup var output: OutputOptions

    func run() throws {
        try Output.run("proposals show", json: output.json) {
            let config = try Config.load()
            let (meeting, dir) = try target.meeting(config)
            let n = try target.number()
            let bita = MeetingContext.bita(meeting, config: config)
            let review = ProposalReview(dir: dir, bita: bita ?? NoBita())
            let proposal = try review.proposal(n)
            let markdown = try? String(contentsOf: URL(fileURLWithPath: proposal.file), encoding: .utf8)
            let diff = proposal.status == .pending || proposal.status == .stale ? review.diff(proposal).map(JSONValue.init) : nil
            var text = ProposalText.line(proposal) + "\n\n" + proposal.rationale
            if let markdown { text += "\n\n" + markdown }
            return (ProposalDetail(proposal: proposal, markdown: markdown, diff: diff), text)
        }
    }
}

struct ProposalsAcceptCommand: ParsableCommand {
    static let configuration = CommandConfiguration(commandName: "accept", abstract: "Apply a proposal to the docs main branch.")

    @OptionGroup var target: ProposalTarget

    @Option(help: "Edited markdown to propose again and apply instead of the original.")
    var md: String?

    @OptionGroup var output: OutputOptions

    func run() throws {
        try Output.run("proposals accept", json: output.json) {
            let config = try Config.load()
            let (_, _, review) = try target.review(config)
            let proposal = try review.accept(try target.number(), editedMarkdown: md.map(Paths.expandTilde))
            let text = proposal.status == .stale
                ? "Proposal \(proposal.n) conflicts with the current page; it is now stale"
                : "Applied proposal \(proposal.n) to \(proposal.pageTitle)"
            return (ProposalData(proposal: proposal), text)
        }
    }
}

struct ProposalsRejectCommand: ParsableCommand {
    static let configuration = CommandConfiguration(commandName: "reject", abstract: "Discard a proposal.")

    @OptionGroup var target: ProposalTarget
    @OptionGroup var output: OutputOptions

    func run() throws {
        try Output.run("proposals reject", json: output.json) {
            let config = try Config.load()
            let (_, _, review) = try target.review(config)
            let proposal = try review.reject(try target.number())
            return (ProposalData(proposal: proposal), "Rejected proposal \(proposal.n)")
        }
    }
}

struct NoBita: BitaCalling {
    func invoke(_ arguments: [String]) throws -> BitaResponse {
        BitaResponse(ok: false, errorCode: "DEPENDENCY_MISSING", errorMessage: "bita not found")
    }
}

enum JSONValue: Encodable {
    case null
    case bool(Bool)
    case number(Double)
    case int(Int)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(_ any: Any) {
        switch any {
        case let value as NSNumber where CFGetTypeID(value) == CFBooleanGetTypeID(): self = .bool(value.boolValue)
        case let value as Int: self = .int(value)
        case let value as Double: self = .number(value)
        case let value as String: self = .string(value)
        case let value as [Any]: self = .array(value.map(JSONValue.init))
        case let value as [String: Any]: self = .object(value.mapValues(JSONValue.init))
        default: self = .null
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case let .bool(value): try container.encode(value)
        case let .number(value): try container.encode(value)
        case let .int(value): try container.encode(value)
        case let .string(value): try container.encode(value)
        case let .array(value): try container.encode(value)
        case let .object(value): try container.encode(value)
        }
    }
}
