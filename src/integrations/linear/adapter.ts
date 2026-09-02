import { linearIntegrationConfig } from "@/services/integration-secret-service";
import { linearGraphql } from "./client";

export const linearAdapter = {
  async createProject(input: { name: string; description: string }) {
    const { teamId } = await linearIntegrationConfig();
    if (!teamId) throw new Error("Linear team ID is not configured for this tenant");
    const query = `
      mutation CreateProject($input: ProjectCreateInput!) {
        projectCreate(input: $input) {
          success
          project { id name url }
        }
      }
    `;
    const data = await linearGraphql<{
      projectCreate: { success: boolean; project: { id: string; name: string; url: string } | null };
    }>(query, {
      input: {
        name: input.name,
        summary: input.description.slice(0, 255),
        teamIds: [teamId],
      },
    });
    if (!data.projectCreate.success || !data.projectCreate.project) throw new Error("Linear project creation failed");
    return { externalId: data.projectCreate.project.id, url: data.projectCreate.project.url };
  },

  async createIssue(input: { projectId: string; title: string; description: string }) {
    const { teamId } = await linearIntegrationConfig();
    if (!teamId) throw new Error("Linear team ID is not configured for this tenant");
    const query = `
      mutation CreateIssue($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue { id identifier url }
        }
      }
    `;
    const data = await linearGraphql<{
      issueCreate: { success: boolean; issue: { id: string; identifier: string; url: string } | null };
    }>(query, {
      input: {
        teamId,
        projectId: input.projectId,
        title: input.title,
        description: input.description,
      },
    });
    if (!data.issueCreate.success || !data.issueCreate.issue) throw new Error("Linear issue creation failed");
    return {
      externalId: data.issueCreate.issue.id,
      identifier: data.issueCreate.issue.identifier,
      url: data.issueCreate.issue.url,
    };
  },
};
