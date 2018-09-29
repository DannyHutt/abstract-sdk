// @flow
import path from "path";
import { spawn } from "child_process";
import { Buffer } from "buffer";
import find from "lodash/find";
import locatePath from "locate-path";
import JSONStream from "JSONStream";
import debug, { debugArgs } from "../debug";
import type {
  AbstractInterface,
  ProjectDescriptor,
  BranchDescriptor,
  PageDescriptor,
  FileDescriptor,
  LayerDescriptor,
  CollectionDescriptor
} from "../";

function parsePath(input: ?string): ?Array<string> {
  if (!input) return;
  return input.split(path.delimiter || ":");
}

function ref(
  objectDescriptor:
    | BranchDescriptor
    | FileDescriptor
    | PageDescriptor
    | LayerDescriptor
) {
  return objectDescriptor.sha || objectDescriptor.branchId;
}

function fileDescriptorForPage(pageDescriptor: PageDescriptor) {
  return {
    projectId: pageDescriptor.projectId,
    branchId: pageDescriptor.branchId,
    sha: pageDescriptor.sha,
    fileId: pageDescriptor.fileId
  };
}

type Options = {
  abstractToken: string,
  abstractCliPath?: string[],
  cwd?: string
};

export default class AbstractCLI implements AbstractInterface {
  abstractToken: string;
  abstractCliPath: string;
  cwd: string;

  constructor({
    cwd = process.cwd(),
    abstractToken,
    abstractCliPath = parsePath(process.env.ABSTRACT_CLI_PATH) || [
      // Relative to cwd
      path.join(cwd, "abstract-cli"),
      // Relative to node_modules in cwd (also makes test easier)
      path.join(
        cwd,
        "node_modules/@elasticprojects/abstract-cli/bin/abstract-cli"
      ),
      // macOS App
      "/Applications/Abstract.app/Contents/Resources/app.asar.unpacked/node_modules/@elasticprojects/abstract-cli"
    ]
  }: Options) {
    this.cwd = cwd;
    this.abstractToken = abstractToken;

    try {
      this.abstractCliPath = path.relative(
        cwd,
        path.resolve(cwd, locatePath.sync(abstractCliPath))
      );
    } catch (error) {
      throw new Error(
        `Cannot find abstract-cli in "${abstractCliPath.join(":")}"`
      );
    }
  }

  commits = {
    list: (
      objectDescriptor: BranchDescriptor | FileDescriptor | LayerDescriptor
    ) => {
      if (objectDescriptor.layerId) {
        return this.spawn([
          "commits",
          objectDescriptor.projectId,
          objectDescriptor.branchId,
          "--layer-id",
          objectDescriptor.layerId
        ]);
      } else if (objectDescriptor.fileId) {
        return this.spawn([
          "commits",
          objectDescriptor.projectId,
          objectDescriptor.branchId,
          "--file-id",
          objectDescriptor.fileId
        ]);
      } else {
        return this.spawn([
          "commits",
          objectDescriptor.projectId,
          objectDescriptor.branchId
        ]);
      }
    },
    info: (
      objectDescriptor: BranchDescriptor | FileDescriptor | LayerDescriptor
    ) => {
      if (objectDescriptor.layerId) {
        return this.spawn([
          "commit",
          objectDescriptor.projectId,
          ref(objectDescriptor)
        ]);
      } else if (objectDescriptor.fileId) {
        return this.spawn([
          "commit",
          objectDescriptor.projectId,
          ref(objectDescriptor)
        ]);
      } else {
        return this.spawn([
          "commit",
          objectDescriptor.projectId,
          ref(objectDescriptor)
        ]);
      }
    }
  };

  files = {
    list: (branchDescriptor: BranchDescriptor) => {
      return this.spawn([
        "files",
        branchDescriptor.projectId,
        ref(branchDescriptor)
      ]);
    },
    info: (fileDescriptor: FileDescriptor) => {
      return this.spawn([
        "file",
        fileDescriptor.projectId,
        ref(fileDescriptor),
        fileDescriptor.fileId
      ]);
    }
  };

  pages = {
    list: async (fileOrBranchDescriptor: BranchDescriptor | FileDescriptor) => {
      const { pages } = fileOrBranchDescriptor.fileId
        ? await this.files.info(fileOrBranchDescriptor)
        : // $FlowFixMe: fileOrBranchDescriptor with no fileId is a BranchDescriptor
          await this.files.list(fileOrBranchDescriptor);

      return pages;
    },
    info: async (pageDescriptor: PageDescriptor) => {
      const { pages } = await this.files.info(
        fileDescriptorForPage(pageDescriptor)
      );

      return find(pages, { id: pageDescriptor.pageId });
    }
  };

  layers = {
    list: (fileDescriptor: FileDescriptor) => {
      return this.spawn([
        "layers",
        fileDescriptor.projectId,
        ref(fileDescriptor),
        fileDescriptor.fileId
      ]);
    },
    info: (layerDescriptor: LayerDescriptor) => {
      return this.spawn([
        "layer",
        "meta",
        layerDescriptor.projectId,
        ref(layerDescriptor),
        layerDescriptor.fileId,
        layerDescriptor.layerId
      ]);
    }
  };

  data = {
    layer: (layerDescriptor: LayerDescriptor) => {
      return this.spawn([
        "layer",
        "data",
        layerDescriptor.projectId,
        ref(layerDescriptor),
        layerDescriptor.fileId,
        layerDescriptor.layerId
      ]);
    }
  };

  collections = {
    list: (projectOrBranchDescriptor: ProjectDescriptor | BranchDescriptor) => {
      if (projectOrBranchDescriptor.branchId) {
        return this.spawn([
          "collections",
          projectOrBranchDescriptor.projectId,
          "--branch",
          projectOrBranchDescriptor.branchId
        ]);
      } else {
        return this.spawn(["collections", projectOrBranchDescriptor.projectId]);
      }
    },
    info: (collectionDescriptor: CollectionDescriptor) => {
      return this.spawn([
        "collection",
        collectionDescriptor.projectId,
        collectionDescriptor.collectionId
      ]);
    }
  };

  async spawn(args: string[]) {
    return new Promise((resolve, reject) => {
      const abstractCli = spawn(
        ...debugArgs("AbstractCLI:spawn")(
          `./${path.relative(this.cwd, this.abstractCliPath)}`,
          [
            ...args,
            `--user-token=${this.abstractToken}`,
            `--api-url=${process.env.ABSTRACT_API_URL ||
              "https://api.goabstract.com"}`
          ],
          {
            cwd: this.cwd
          }
        )
      );

      let stderrBuffer = new Buffer.from("");
      abstractCli.stderr.on("data", chunk => {
        stderrBuffer.concat(chunk);
      });

      abstractCli.stdout
        .pipe(JSONStream.parse())
        .on("data", data => {
          debug("AbstractCLI:stdout:data")(data);
          resolve(data);
        })
        .on("error", error => {
          debug("AbstractCLI:stdout:error")(error.toString());
          reject(error);
        });

      abstractCli.on("error", reject);
      abstractCli.on("close", errorCode => {
        debug("AbstractCLI:close")(errorCode);

        if (errorCode !== 0) {
          debug("AbstractCLI:error")(stderrBuffer.toString());
          reject(stderrBuffer); // Reject stderr for non-zero error codes
        }
      });
    });
  }
}