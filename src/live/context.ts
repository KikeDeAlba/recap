import path from 'node:path'
import { isDirectory } from '../core/fsutil.ts'
import { isRecord } from '../core/json.ts'
import type { Meeting } from '../core/meeting.ts'
import { trimmed } from '../core/text.ts'
import type { BitaCalling } from '../bita/client.ts'

export interface PageRef {
  pageId: number
  title: string
  relPath: string
  depth: number
}

export interface RepoRef {
  path: string
  slug: string
  exists: boolean
}

export interface ProjectContext {
  project: string | null
  docsRoot: string | null
  pages: PageRef[]
  repos: RepoRef[]
}

export function emptyContext(overrides: Partial<ProjectContext> = {}): ProjectContext {
  return { project: null, docsRoot: null, pages: [], repos: [], ...overrides }
}

export function existingRepos(context: ProjectContext): RepoRef[] {
  return context.repos.filter((repo) => repo.exists)
}

export function parsePages(data: unknown): PageRef[] {
  const list = isRecord(data) && Array.isArray(data['pages']) ? data['pages'] : []
  const result: PageRef[] = []
  const walk = (items: unknown[], depth: number) => {
    for (const item of items) {
      if (!isRecord(item)) continue
      const id = item['pageId']
      const title = item['title']
      if (typeof id !== 'number' || !Number.isInteger(id) || typeof title !== 'string') continue
      result.push({
        pageId: id,
        title,
        relPath: typeof item['relPath'] === 'string' ? item['relPath'] : '',
        depth: typeof item['depth'] === 'number' && Number.isInteger(item['depth']) ? item['depth'] : depth,
      })
      if (Array.isArray(item['children'])) walk(item['children'], depth + 1)
    }
  }
  walk(list, 0)
  return result
}

export function parseRepos(data: unknown): RepoRef[] {
  const list = isRecord(data) && Array.isArray(data['repos']) ? data['repos'] : []
  const seen = new Set<string>()
  const result: RepoRef[] = []
  for (const item of list) {
    if (!isRecord(item)) continue
    const repoPath = item['path']
    if (typeof repoPath !== 'string' || repoPath.length === 0 || seen.has(repoPath)) continue
    seen.add(repoPath)
    const slugValue = typeof item['slug'] === 'string' && item['slug'].length > 0 ? item['slug'] : path.basename(repoPath)
    const reported = typeof item['exists'] === 'boolean' ? item['exists'] : true
    result.push({ path: repoPath, slug: slugValue, exists: reported && isDirectory(repoPath) })
  }
  return result
}

function metaRoot(meta: Record<string, unknown> | undefined): string | null {
  return typeof meta?.['root'] === 'string' ? meta['root'] : null
}

export async function loadProjectContext(project: string | null | undefined, docsRoot: string | null | undefined, bita: BitaCalling | null): Promise<ProjectContext> {
  const context = emptyContext({ project: project && trimmed(project).length > 0 ? project : null, docsRoot: docsRoot ?? null })
  if (!bita) return context
  if (context.project) {
    const pages = await bita.invoke(['docs', 'page', 'ls', '--project', context.project]).catch(() => null)
    if (pages?.ok) {
      context.pages = parsePages(pages.data)
      context.docsRoot ??= metaRoot(pages.meta)
    }
    const repos = await bita.invoke(['project', 'repo', 'ls', '--project', context.project]).catch(() => null)
    if (repos?.ok) context.repos = parseRepos(repos.data)
  }
  if (context.docsRoot === null) {
    const tree = await bita.invoke(['docs', 'tree']).catch(() => null)
    if (tree?.ok) context.docsRoot = metaRoot(tree.meta)
  }
  return context
}

export function meetingProjectName(meeting: Meeting): string | null {
  return meeting.bitaEntry?.projectName ?? meeting.wrapup?.project ?? null
}

export async function meetingProject(meeting: Meeting, bita: BitaCalling | null): Promise<string | null> {
  const name = meetingProjectName(meeting)
  if (name && trimmed(name).length > 0) return name
  const pageId = meeting.wrapup?.pageId ?? meeting.bitaEntry?.pageIds[0]
  if (!bita || pageId === undefined) return null
  const response = await bita.invoke(['docs', 'page', 'show', String(pageId), '--no-markdown']).catch(() => null)
  if (!response?.ok || !isRecord(response.data)) return null
  return typeof response.data['projectName'] === 'string' ? response.data['projectName'] : null
}

