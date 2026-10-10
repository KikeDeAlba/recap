import path from 'node:path'
import { isDirectory } from '../core/fsutil.ts'
import { isRecord } from '../core/json.ts'
import type { Meeting } from '../core/meeting.ts'
import { trimmed } from '../core/text.ts'
import { BitaClient, INKWELL_CAPABILITIES, findInkwell, meetingTarget, type ToolCalling } from '../bita/client.ts'
import type { Config } from '../core/config.ts'

export interface PageRef {
  pageId: number
  title: string
  relPath: string
  depth: number
  projectName?: string | undefined
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
        ...(typeof item['projectName'] === 'string' ? { projectName: item['projectName'] } : {}),
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

export interface ContextSources {
  inkwell: ToolCalling | null
  bita: ToolCalling | null
}

export async function loadProjectContext(project: string | null | undefined, sources: ContextSources): Promise<ProjectContext> {
  const context = emptyContext({ project: project && trimmed(project).length > 0 ? project : null })
  const { inkwell, bita } = sources
  if (context.project) {
    if (inkwell) {
      const pages = await inkwell.invoke(['page', 'ls', '--project', context.project]).catch(() => null)
      if (pages?.ok) {
        context.pages = parsePages(pages.data)
        context.docsRoot = metaRoot(pages.meta)
      }
    }
    if (bita) {
      const repos = await bita.invoke(['project', 'repo', 'ls', '--project', context.project]).catch(() => null)
      if (repos?.ok) context.repos = parseRepos(repos.data)
    }
  }
  if (context.docsRoot === null && inkwell) {
    const tree = await inkwell.invoke(['tree']).catch(() => null)
    if (tree?.ok) context.docsRoot = metaRoot(tree.meta)
  }
  return context
}

export async function entryPages(inkwell: ToolCalling | null, entryId: number | undefined): Promise<PageRef[]> {
  if (!inkwell || entryId === undefined) return []
  const response = await inkwell.invoke(['page', 'ls', '--entry', String(entryId)]).catch(() => null)
  return response?.ok ? parsePages(response.data) : []
}

export function meetingProjectName(meeting: Meeting): string | null {
  return meeting.bitaEntry?.projectName ?? meeting.wrapup?.project ?? null
}

export async function meetingProject(meeting: Meeting, inkwell: ToolCalling | null, linked?: readonly PageRef[]): Promise<string | null> {
  const name = meetingProjectName(meeting)
  if (name && trimmed(name).length > 0) return name
  if (!inkwell) return null
  const pageId = meeting.wrapup?.pageId
  if (pageId !== undefined) {
    const response = await inkwell.invoke(['page', 'show', String(pageId), '--no-markdown']).catch(() => null)
    if (response?.ok && isRecord(response.data) && typeof response.data['projectName'] === 'string') return response.data['projectName']
  }
  const pages = linked ?? (await entryPages(inkwell, meeting.bitaEntryId))
  return pages.find((page) => page.projectName !== undefined)?.projectName ?? null
}

export async function contextSources(config: Config, meeting: Meeting | null): Promise<ContextSources> {
  const inkwell = await findInkwell(INKWELL_CAPABILITIES.pages)
  const bita = await BitaClient.create(config, meeting ? meetingTarget(meeting) : {})
  return { inkwell, bita }
}

export async function meetingContext(meeting: Meeting, config: Config): Promise<ProjectContext> {
  const sources = await contextSources(config, meeting)
  return loadProjectContext(await meetingProject(meeting, sources.inkwell), sources)
}
