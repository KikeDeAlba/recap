import Foundation
import Testing
@testable import recap

@Suite struct ToolEnvironmentTests {
    @Test func fillsTheUserWhenTheCallerClearedIt() {
        let environment = Tool.environment(for: URL(fileURLWithPath: "/usr/local/bin/claude"), config: Config(),
                                           base: ["PATH": "/usr/bin", "HOME": "/Users/someone"])
        #expect(environment["USER"] == NSUserName())
        #expect(environment["LOGNAME"] == NSUserName())
        #expect(environment["HOME"] == "/Users/someone")
    }

    @Test func keepsAUserThatIsAlreadySet() {
        let environment = Tool.environment(for: URL(fileURLWithPath: "/usr/local/bin/claude"), config: Config(),
                                           base: ["USER": "ana", "LOGNAME": "ana"])
        #expect(environment["USER"] == "ana")
        #expect(environment["LOGNAME"] == "ana")
    }
}
