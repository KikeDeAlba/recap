import ArgumentParser
import Foundation

struct RecapError: Error, CustomStringConvertible {
    let code: String
    let message: String

    init(_ code: String, _ message: String) {
        self.code = code
        self.message = message
    }

    var description: String { "\(code): \(message)" }
}

struct ErrorBody: Encodable {
    let code: String
    let message: String
}

struct Envelope<T: Encodable>: Encodable {
    let schemaVersion = 1
    let ok: Bool
    let command: String
    let generatedAt: Date
    let data: T?
    let error: ErrorBody?
}

struct OutputOptions: ParsableArguments {
    @Flag(name: .long, help: "Print a JSON envelope instead of text.")
    var json = false
}

enum Output {
    static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()

    static func run<T: Encodable>(_ command: String, json: Bool, _ body: () throws -> (T, String)) throws {
        do {
            let (data, text) = try body()
            if json {
                emit(Envelope(ok: true, command: command, generatedAt: Date(), data: data, error: nil))
            } else if !text.isEmpty {
                print(text)
            }
        } catch {
            let failure = (error as? RecapError) ?? RecapError("UNEXPECTED", String(describing: error))
            if json {
                emit(Envelope<String>(ok: false, command: command, generatedAt: Date(), data: nil,
                                      error: ErrorBody(code: failure.code, message: failure.message)))
            } else {
                FileHandle.standardError.write(Data("recap: \(failure.message) [\(failure.code)]\n".utf8))
            }
            throw ExitCode(1)
        }
    }

    private static func emit<T: Encodable>(_ envelope: Envelope<T>) {
        guard let data = try? encoder.encode(envelope) else { return }
        print(String(decoding: data, as: UTF8.self))
    }
}
