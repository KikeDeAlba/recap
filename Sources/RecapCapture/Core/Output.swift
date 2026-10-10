import ArgumentParser
import Foundation

package struct RecapError: Error, CustomStringConvertible {
    package let code: String
    package let message: String

    package init(_ code: String, _ message: String) {
        self.code = code
        self.message = message
    }

    package var description: String { "\(code): \(message)" }
}

package struct ErrorBody: Encodable {
    package let code: String
    package let message: String
}

package struct Envelope<T: Encodable>: Encodable {
    package let schemaVersion = 1
    package let ok: Bool
    package let command: String
    package let generatedAt: Date
    package let data: T?
    package let error: ErrorBody?
}

package struct OutputOptions: ParsableArguments {
    @Flag(name: .long, help: "Print a JSON envelope instead of text.")
    package var json = false

    package init() {}
}

package enum Output {
    package static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()

    package static let compactEncoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()

    package static func run<T: Encodable>(_ command: String, json: Bool, program: String = "recap", compact: Bool = false,
                                          _ body: () throws -> (T, String)) throws {
        do {
            let (data, text) = try body()
            if json {
                emit(success(command, data), compact: compact)
            } else if !text.isEmpty {
                print(text)
            }
        } catch {
            let failure = (error as? RecapError) ?? RecapError("UNEXPECTED", String(describing: error))
            if json {
                emit(failureEnvelope(command, failure), compact: compact)
            } else {
                FileHandle.standardError.write(Data("\(program): \(failure.message) [\(failure.code)]\n".utf8))
            }
            throw ExitCode(1)
        }
    }

    package static func success<T: Encodable>(_ command: String, _ data: T) -> Envelope<T> {
        Envelope(ok: true, command: command, generatedAt: Date(), data: data, error: nil)
    }

    package static func failureEnvelope(_ command: String, _ failure: RecapError) -> Envelope<String> {
        Envelope<String>(ok: false, command: command, generatedAt: Date(), data: nil,
                         error: ErrorBody(code: failure.code, message: failure.message))
    }

    package static func render<T: Encodable>(_ envelope: Envelope<T>, compact: Bool) -> String? {
        guard let data = try? (compact ? compactEncoder : encoder).encode(envelope) else { return nil }
        return String(decoding: data, as: UTF8.self)
    }

    package static func emit<T: Encodable>(_ envelope: Envelope<T>, compact: Bool = false) {
        guard let text = render(envelope, compact: compact) else { return }
        print(text)
    }
}
