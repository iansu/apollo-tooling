import {
  WorkspaceFolder,
  NotificationHandler,
  PublishDiagnosticsParams
} from "vscode-languageserver";
import Uri from "vscode-uri";
import { QuickPickItem } from "vscode";

import { GraphQLProject, DocumentUri } from "./project";
import { dirname } from "path";
import * as fg from "glob";
import { loadConfig, projectsFromConfig, ApolloConfigFormat } from "./config";
import { LoadingHandler } from "./loadingHandler";
import { ServiceID, SchemaTag } from "./engine";
import { GraphQLClientProject } from "./clientProject";

export class GraphQLWorkspace {
  private _onDiagnostics?: NotificationHandler<PublishDiagnosticsParams>;
  private _onDecorations?: (any: any) => void;
  private _onSchemaTags?: NotificationHandler<[ServiceID, SchemaTag[]]>;

  private projectsByFolderUri: Map<string, GraphQLProject[]> = new Map();

  constructor(private loadingHandler: LoadingHandler) {}

  onDiagnostics(handler: NotificationHandler<PublishDiagnosticsParams>) {
    this._onDiagnostics = handler;
  }

  onDecorations(handler: (any: any) => void) {
    this._onDecorations = handler;
  }

  onSchemaTags(handler: NotificationHandler<[ServiceID, SchemaTag[]]>) {
    this._onSchemaTags = handler;
  }

  addProjectsInFolder(folder: WorkspaceFolder) {
    // load all possible workspace projects (contains possible config)
    const apolloConfigFiles: string[] = fg.sync("**/apollo.config.(js|ts)", {
      cwd: Uri.parse(folder.uri).fsPath,
      absolute: true,
      ignore: "**/node_modules/**"
    });

    apolloConfigFiles.push(
      ...fg.sync("**/package.json", {
        cwd: Uri.parse(folder.uri).fsPath,
        absolute: true,
        ignore: "**/node_modules/**"
      })
    );

    // only have unique possible folders
    const apolloConfigFolders = new Set<string>(
      apolloConfigFiles.map(f => dirname(f))
    );

    // go from possible folders to known array of configs
    const projectConfigs = Array.from(apolloConfigFolders).map(configFolder =>
      this.loadingHandler.handle<ApolloConfigFormat | null>(
        `Loading Apollo Config in folder ${configFolder}`,
        (async () => {
          try {
            const config = await loadConfig({ cwd: configFolder });
            return config && config.config;
          } catch (e) {
            console.error(e);
            return null;
          }
        })()
      )
    );

    Promise.all(projectConfigs)
      .then(configs =>
        configs.filter(Boolean).flatMap(projectConfig => {
          // we create a GraphQLProject for each kind of project
          return projectsFromConfig(projectConfig as ApolloConfigFormat).map(
            config => {
              const project = new GraphQLClientProject(
                config,
                this.loadingHandler,
                folder.uri
              );

              project.onDiagnostics(params => {
                this._onDiagnostics && this._onDiagnostics(params);
              });

              project.onDecorations(params => {
                this._onDecorations && this._onDecorations(params);
              });

              project.onSchemaTags((tags: string[]) => {
                this._onSchemaTags && this._onSchemaTags(tags);
              });

              return project;
            }
          );
        })
      )
      .then(projects => this.projectsByFolderUri.set(folder.uri, projects));
  }

  updateSchemaTag(selection: QuickPickItem) {
    const serviceID = selection.detail;
    if (!serviceID) return;

    this.projectsByFolderUri.forEach(projects => {
      projects.forEach(project => {
        if (
          project instanceof GraphQLClientProject &&
          project.serviceID === serviceID
        ) {
          project.updateSchemaTag(selection.label);
        }
      });
    });
  }

  removeProjectsInFolder(folder: WorkspaceFolder) {
    const projects = this.projectsByFolderUri.get(folder.uri);
    if (projects) {
      projects.forEach(project => project.clearAllDiagnostics());
      this.projectsByFolderUri.delete(folder.uri);
    }
  }

  projectForFile(uri: DocumentUri): GraphQLProject | undefined {
    for (const projects of this.projectsByFolderUri.values()) {
      const project = projects.find(project => project.includesFile(uri));
      if (project) {
        return project;
      }
    }
    return undefined;
  }
}
