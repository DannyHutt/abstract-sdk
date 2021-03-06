// @flow
import path from "path";
import { spawn } from "child_process";
import { Buffer } from "buffer";
import find from "lodash/find";
import locatePath from "locate-path";
import JSONStream from "JSONStream";
import { objectFileDescriptor } from "../utils";
import { log } from "../debug";
import type {
  AbstractInterface,
  ProjectDescriptor,
  CommitDescriptor,
  BranchDescriptor,
  PageDescriptor,
  FileDescriptor,
  LayerDescriptor,
  CollectionDescriptor
} from "../";

const logSpawn = log.extend("AbstractCLI:spawn");
const logError = log.extend("AbstractCLI:error");
const logStdoutError = log.extend("AbstractCLI:stdout:error");
const logStdoutData = log.extend("AbstractCLI:stdout:data");
const logStderrData = log.extend("AbstractCLI:stderr");
const logClose = log.extend("AbstractCLI:close");

function parsePath(input: ?string): ?Array<string> {
  if (!input) return;
  return input.split(path.delimiter || ":");
}

export type Options = {
  accessToken: string,
  cliPath?: string[],
  apiUrl?: string,
  cwd?: string
};

export default class AbstractCLI implements AbstractInterface {
  accessToken: string;
  cliPath: string;
  apiUrl: string;
  cwd: string;

  constructor({
    cwd = process.cwd(),
    accessToken,
    cliPath = parsePath(process.env.ABSTRACT_CLI_PATH) || [
      // Relative to cwd
      path.join(cwd, "abstract-cli"),
      // Relative to node_modules in cwd (also makes test easier)
      path.join(
        cwd,
        "node_modules/@elasticprojects/abstract-cli/bin/abstract-cli"
      ),
      // macOS App
      "/Applications/Abstract.app/Contents/Resources/app.asar.unpacked/node_modules/@elasticprojects/abstract-cli/bin/abstract-cli"
    ],
    apiUrl = "https://api.goabstract.com"
  }: Options = {}) {
    this.cwd = cwd;
    this.accessToken = accessToken;
    this.apiUrl = apiUrl;

    try {
      this.cliPath = path.resolve(cwd, locatePath.sync(cliPath));
    } catch (error) {
      throw new Error(`Cannot find abstract-cli in "${cliPath.join(":")}"`);
    }
  }

  async spawn(args: string[]) {
    return new Promise((resolve, reject) => {
      const userToken = this.accessToken
        ? ["--user-token", this.accessToken]
        : [];

      const spawnArgs = [
        this.cliPath,
        [
          ...userToken,
          "--api-url",
          this.apiUrl,
          ...args // First args win for https://github.com/spf13/cobra
        ],
        { cwd: this.cwd }
      ];

      logSpawn(spawnArgs);
      const abstractCli = spawn(...spawnArgs);

      let stderrBuffer = Buffer.from("");
      abstractCli.stderr.on("data", chunk => {
        logStderrData(chunk.toString());
        stderrBuffer = Buffer.concat([stderrBuffer, chunk]);
      });

      const stream = JSONStream.parse();
      stream.on("data", data => {
        logStdoutData(data);
        resolve(data);
      });

      abstractCli.stdout
        .on("data", data => {
          stream.write(data);
        })
        .on("error", error => {
          logStdoutError(error.toString());
          reject(error);
        })
        .on("end", () => {
          stream.end();
        });

      abstractCli.on("error", reject);
      abstractCli.on("close", errorCode => {
        logClose(errorCode);

        if (errorCode !== 0) {
          logError(stderrBuffer.toString());
          reject(stderrBuffer); // Reject stderr for non-zero error codes
        }
      });
    });
  }

  async resolveDescriptor<T: *>(objectDescriptor: T): Promise<T> {
    if (objectDescriptor.sha !== "latest") return objectDescriptor;

    const commits = await this.commits.list(objectDescriptor, { limit: 1 });

    try {
      return {
        ...objectDescriptor,
        sha: commits[0].sha
      };
    } catch (error) {
      throw new Error(
        `Could not resolve sha "latest" for ${JSON.stringify(objectDescriptor)}`
      );
    }
  }

  commits = {
    list: async (
      objectDescriptor:
        | BranchDescriptor
        | FileDescriptor
        | PageDescriptor
        | LayerDescriptor,
      options?: { limit?: number } = {}
    ) => {
      const fileIdArgs = objectDescriptor.fileId
        ? ["--file-id", objectDescriptor.fileId]
        : [];

      const layerIdArgs = objectDescriptor.layerId
        ? ["--layer-id", objectDescriptor.layerId]
        : [];

      const limitArgs = options.limit
        ? ["--limit", options.limit.toString()]
        : [];

      const data = await this.spawn([
        "commits",
        objectDescriptor.projectId,
        objectDescriptor.branchId,
        ...fileIdArgs,
        ...layerIdArgs,
        ...limitArgs
      ]);

      return data.commits;
    },
    info: async (
      objectDescriptor:
        | BranchDescriptor
        | FileDescriptor
        | CommitDescriptor
        | LayerDescriptor
    ) => {
      if (!objectDescriptor.sha) throw new Error("commits.info requires sha");

      const data = await this.spawn([
        "commit",
        objectDescriptor.projectId,
        objectDescriptor.sha ? objectDescriptor.sha : "latest" // TODO latest
      ]);

      return data.commit;
    }
  };

  changesets = {
    info: async (commitDescriptor: CommitDescriptor) => {
      return this.spawn([
        "changeset",
        commitDescriptor.projectId,
        "--commit",
        commitDescriptor.sha,
        "--branch",
        commitDescriptor.branchId
      ]);
    }
  };

  files = {
    list: async (branchDescriptor: BranchDescriptor) => {
      branchDescriptor = await this.resolveDescriptor(branchDescriptor);

      const data = await this.spawn([
        "files",
        branchDescriptor.projectId,
        branchDescriptor.sha
      ]);

      return data.files;
    },
    info: async (fileDescriptor: FileDescriptor) => {
      fileDescriptor = await this.resolveDescriptor(fileDescriptor);

      const data = await this.spawn([
        "file",
        fileDescriptor.projectId,
        fileDescriptor.sha,
        fileDescriptor.fileId
      ]);

      const file = {
        ...data.file,
        _pages: data.pages
      };

      return file;
    }
  };

  pages = {
    list: async (fileDescriptor: FileDescriptor) => {
      const file: File = await this.files.info(fileDescriptor);
      // $FlowFixMe: _pages not in type
      return file._pages;
    },
    info: async (pageDescriptor: PageDescriptor) => {
      const pages = await this.pages.list(objectFileDescriptor(pageDescriptor));
      return find(pages, { id: pageDescriptor.pageId });
    }
  };

  layers = {
    list: async (fileDescriptor: FileDescriptor) => {
      fileDescriptor = await this.resolveDescriptor(fileDescriptor);

      return this.spawn([
        "layers",
        fileDescriptor.projectId,
        fileDescriptor.sha,
        fileDescriptor.fileId
      ]);
    },
    info: async (layerDescriptor: LayerDescriptor) => {
      layerDescriptor = await this.resolveDescriptor(layerDescriptor);

      const data = await this.spawn([
        "layer",
        "meta",
        layerDescriptor.projectId,
        layerDescriptor.sha,
        layerDescriptor.fileId,
        layerDescriptor.layerId
      ]);

      return data.layer;
    }
  };

  data = {
    info: async (layerDescriptor: LayerDescriptor) => {
      layerDescriptor = await this.resolveDescriptor(layerDescriptor);

      return this.spawn([
        "layer",
        "data",
        layerDescriptor.projectId,
        layerDescriptor.sha,
        layerDescriptor.fileId,
        layerDescriptor.layerId
      ]);
    }
  };

  collections = {
    list: (projectOrBranchDescriptor: ProjectDescriptor | BranchDescriptor) => {
      const branchArgs = projectOrBranchDescriptor.branchId
        ? ["--branch", projectOrBranchDescriptor.branchId]
        : [];

      return this.spawn([
        "collections",
        projectOrBranchDescriptor.projectId,
        ...branchArgs
      ]);
    },
    info: (collectionDescriptor: CollectionDescriptor) => {
      return this.spawn([
        "collection",
        collectionDescriptor.projectId,
        collectionDescriptor.collectionId
      ]);
    }
  };
}
