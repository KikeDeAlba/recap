import Foundation

package enum Channel: String, Codable {
    case mic
    case system

    package var speakerLabel: String {
        switch self {
        case .mic: "Sala"
        case .system: "Remotos"
        }
    }
}

extension String {
    package var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}
