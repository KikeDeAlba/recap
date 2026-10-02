import Foundation
import Testing
@testable import recap

@Suite struct SlugTests {
    @Test func foldsAccentsAndPunctuation() {
        #expect(Slug.make("Reunión de diseño: API v2!") == "reunion-de-diseno-api-v2")
    }

    @Test func fallsBackWhenEmpty() {
        #expect(Slug.make("¿¡ !?") == "meeting")
    }

    @Test func truncatesLongTitles() {
        #expect(Slug.make(String(repeating: "a", count: 80)).count == 48)
    }
}

@Suite struct MeetingStoreTests {
    private func makeStore() throws -> (MeetingStore, URL) {
        let root = FileManager.default.temporaryDirectory.appending(path: "recap-tests-\(UUID().uuidString)")
        var config = Config()
        config.root = root.path
        return (MeetingStore(config: config), root)
    }

    @Test func createsUniqueIdsForTheSameMinute() throws {
        let (store, root) = try makeStore()
        defer { try? FileManager.default.removeItem(at: root) }
        let now = Date(timeIntervalSince1970: 1_790_000_000)
        let (first, _) = try store.create(title: "Daily", mode: .remote, display: nil, bitaEntryId: nil, now: now)
        let (second, _) = try store.create(title: "Daily", mode: .inPerson, display: nil, bitaEntryId: nil, now: now)
        #expect(first.id != second.id)
        #expect(second.id == "\(first.id)-2")
    }

    @Test func resolvesByPartialIdAndBitaEntry() throws {
        let (store, root) = try makeStore()
        defer { try? FileManager.default.removeItem(at: root) }
        let (planning, _) = try store.create(title: "Sprint planning", mode: .remote, display: nil, bitaEntryId: 42)
        _ = try store.create(title: "Retro", mode: .inPerson, display: nil, bitaEntryId: nil)
        #expect(try store.resolve("planning").0.id == planning.id)
        #expect(store.find(bitaEntryId: 42)?.0.id == planning.id)
        #expect(store.find(bitaEntryId: 7) == nil)
    }

    @Test func rejectsAmbiguousReferences() throws {
        let (store, root) = try makeStore()
        defer { try? FileManager.default.removeItem(at: root) }
        _ = try store.create(title: "Sync one", mode: .remote, display: nil, bitaEntryId: nil)
        _ = try store.create(title: "Sync two", mode: .remote, display: nil, bitaEntryId: nil)
        #expect(throws: RecapError.self) { try store.resolve("sync") }
    }

    @Test func roundTripsMeetingFile() throws {
        let (store, root) = try makeStore()
        defer { try? FileManager.default.removeItem(at: root) }
        let (_, dir) = try store.create(title: "Demo", mode: .inPerson, display: nil, bitaEntryId: 9)
        let updated = try MeetingFile.update(dir) {
            $0.status = .recorded
            $0.stages["transcribe"] = StageState(status: "done", updatedAt: Date())
        }
        let loaded = try MeetingFile.load(dir)
        #expect(loaded.status == .recorded)
        #expect(loaded.mode == .inPerson)
        #expect(loaded.stages["transcribe"]?.status == updated.stages["transcribe"]?.status)
    }
}
