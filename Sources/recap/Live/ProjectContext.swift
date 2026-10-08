import Foundation

struct PageRef: Codable, Equatable {
    var pageId: Int
    var title: String
    var relPath: String
    var depth: Int
}

struct RepoRef: Codable, Equatable {
    var path: String
    var slug: String
    var exists: Bool
}

struct ProjectContext: Equatable {
    var project: String?
    var docsRoot: String?
    var pages: [PageRef] = []
    var repos: [RepoRef] = []

    var existingRepos: [RepoRef] { repos.filter(\.exists) }

    func absolutePath(_ page: PageRef) -> String? {
        docsRoot.map { URL(fileURLWithPath: $0).appending(path: page.relPath).path }
    }
}

enum ProjectContextLoader {
    static func load(project: String?, docsRoot: String?, bita: BitaCalling?) -> ProjectContext {
        var context = ProjectContext(project: project?.trimmed.isEmpty == true ? nil : project, docsRoot: docsRoot)
        guard let bita else { return context }
        if let project = context.project {
            if let response = try? bita.invoke(["docs", "page", "ls", "--project", project]), response.ok {
                context.pages = pages(response.data)
                if context.docsRoot == nil { context.docsRoot = response.meta?["root"] as? String }
            }
            if let response = try? bita.invoke(["project", "repo", "ls", "--project", project]), response.ok {
                context.repos = repos(response.data)
            }
        }
        if context.docsRoot == nil, let response = try? bita.invoke(["docs", "tree"]), response.ok {
            context.docsRoot = response.meta?["root"] as? String
        }
        return context
    }

    static func pages(_ data: Any?) -> [PageRef] {
        let list = (data as? [String: Any])?["pages"] as? [[String: Any]] ?? []
        var result: [PageRef] = []
        func walk(_ items: [[String: Any]], depth: Int) {
            for item in items {
                guard let id = item["pageId"] as? Int, let title = item["title"] as? String else { continue }
                result.append(PageRef(pageId: id, title: title, relPath: item["relPath"] as? String ?? "",
                                      depth: item["depth"] as? Int ?? depth))
                if let children = item["children"] as? [[String: Any]] { walk(children, depth: depth + 1) }
            }
        }
        walk(list, depth: 0)
        return result
    }

    static func repos(_ data: Any?) -> [RepoRef] {
        let list = (data as? [String: Any])?["repos"] as? [[String: Any]] ?? []
        var seen = Set<String>()
        return list.compactMap { item in
            guard let path = item["path"] as? String, !path.isEmpty, seen.insert(path).inserted else { return nil }
            let slug = (item["slug"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? URL(fileURLWithPath: path).lastPathComponent
            let reported = item["exists"] as? Bool ?? true
            var isDirectory: ObjCBool = false
            let present = FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory) && isDirectory.boolValue
            return RepoRef(path: path, slug: slug, exists: reported && present)
        }
    }
}

enum MeetingContext {
    static func project(_ meeting: Meeting) -> String? {
        meeting.bitaEntry?.projectName ?? meeting.wrapup?.project
    }

    static func bita(_ meeting: Meeting, config: Config) -> BitaClient? {
        try? BitaClient(config: config, target: BitaTarget(databasePath: meeting.bitaDatabasePath, docsRoot: meeting.bitaDocsRoot))
    }
}
