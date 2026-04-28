import type { ProjectMeta } from '../types'
import type { AdapterRegistry } from './adapter-registry'

export class ProjectResolver {
  constructor(private readonly registry: AdapterRegistry) {}

  async resolveProject(path: string): Promise<ProjectMeta | undefined> {
    return this.registry.resolveProject(path)
  }

  async resolveProjectFilter(filter: { project?: string; path?: string }): Promise<string | undefined> {
    if (filter.project) return filter.project
    if (filter.path) {
      const project = await this.resolveProject(filter.path)
      return project?.slug
    }
    return undefined
  }
}
