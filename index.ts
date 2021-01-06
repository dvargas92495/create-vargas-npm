#!/usr/bin/env node
import validateNpmName from "validate-npm-package-name";
import chalk from "chalk";
import fs from "fs";
import path from "path";
import os from "os";
import { sync } from "cross-spawn";
import copyfiles from "copyfiles";
import sodium from "tweetsodium";
import axios from "axios";
import Listr from "listr";

const npmToken = process.env.NPM_TOKEN || "";
const projectName = process.argv[2] || "";
const opts = process.argv.slice(3);
const isReact = opts.includes("--react");
const root = path.resolve(projectName);

const tasks = new Listr([
  {
    title: "Validate Package Name",
    task: () => {
      const { validForNewPackages, errors, warnings } = validateNpmName(
        projectName
      );
      if (!validForNewPackages) {
        throw new Error(
          `Could not create a project called ${chalk.red(
            `"${projectName}"`
          )} because of npm naming restrictions:
    ${errors?.map((p) => `    ${chalk.red.bold("*")} ${p}`)}
    ${warnings?.map((p) => `    ${chalk.yellow.bold("*")} ${p}`)}
          `
        );
      }
    },
  },
  {
    title: "Make Project Directory",
    task: () => fs.mkdirSync(projectName),
  },
  {
    title: "Write Package JSON",
    task: () => {
      const packageJson = {
        name: projectName,
        description: `Description for ${projectName}`,
        version: "0.0.0",
        main: "dist/index.js",
        types: "lib/index.d.ts",
        scripts: {
          build: `ncc build src/index.ts${isReact ? "x" : ""} -o dist`,
          format: `prettier --write "src/**/*.ts${isReact ? "x" : ""}"`,
          lint: `eslint . --ext .ts${isReact ? ",.tsx" : ""}`,
          prepublishOnly: "npm t",
          preversion: "npm run lint",
          version: "npm run format && git add -A src",
          postversion: "git push origin main && git push --tags",
          pretest: "npm run lint",
          test: "jest --config jestconfig.json",
        },
        license: "MIT",
        peerDependencies: {
          react: "^16.8.0 || ^17",
          "react-dom": "^16.8.0 || ^17",
        },
      };

      return fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify(packageJson, null, 2) + os.EOL
      );
    },
  },
  {
    title: "Write README.md",
    task: () =>
      fs.writeFileSync(
        path.join(root, "README.md"),
        `# ${projectName}
    
    Description for ${projectName}
    `
      ),
  },
  {
    title: "Install Dev Packages",
    task: () => {
      process.chdir(root);
      return sync(
        `npm install --save-dev @types/jest @vercel/ncc @typescript-eslint/parser @typescript-eslint/eslint-plugin eslint jest prettier ts-jest tslint-config-prettier typescript${
          isReact
            ? " @testing-library/jest-dom @testing-library/react @testing-library/user-event @types/react @types/react-dom tslint-react-hooks"
            : ""
        }`
      );
    },
  },
  {
    title: "Install Packages",
    task: () => {
      process.chdir(root);
      return Promise.resolve(sync("npm install --save react react-dom"));
    },
    skip: () => !isReact,
  },
  {
    title: "Copy Template",
    task: () => {
      process.chdir("template");
      return new Promise<void>((resolve) => {
        copyfiles(
          [path.join("**", "*"), root],
          {
            all: true,
          },
          () => resolve()
        );
      });
    },
  },
  {
    title: "RM Unnecessary Template",
    task: () => {
      if (isReact) {
        fs.unlinkSync(path.join(root, "src", "index.ts"));
        fs.unlinkSync(path.join(root, "test", "index.test.ts"));
      } else {
        fs.unlinkSync(path.join(root, "src", "index.tsx"));
        fs.unlinkSync(path.join(root, "test", "index.test.tsx"));
      }
    },
  },
  {
    title: "Add NPM Token",
    task: () => {
      // https://docs.github.com/en/free-pro-team@latest/rest/reference/actions#example-encrypting-a-secret-using-nodejs
      const messageBytes = Buffer.from(npmToken);
      const githubOpts = {
        headers: {
          Authorization: `token ${process.env.GITHUB_TOKEN}`,
        },
      };
      return axios
        .get(
          `https://api.github.com/repos/dvargas92495/${projectName}/actions/secrets/public-key`,
          githubOpts
        )
        .then(({ data: { key } }) => {
          const keyBytes = Buffer.from(key, "base64");
          const encryptedBytes = sodium.seal(messageBytes, keyBytes);
          const encrypted_value = Buffer.from(encryptedBytes).toString(
            "base64"
          );
          return axios.put(
            `https://api.github.com/repos/dvargas92495/${projectName}/actions/secrets/NPM_TOKEN`,
            {
              encrypted_value,
            },
            githubOpts
          );
        });
    },
    skip: () => !!npmToken,
  },
  {
    title: "Git init",
    task: () => {
      process.chdir(root);
      return sync("git init", { stdio: "ignore" });
    },
  },
  {
    title: "Git add",
    task: () => {
      process.chdir(root);
      return sync("git add -A", { stdio: "ignore" });
    },
  },
  {
    title: "Git commit",
    task: () => {
      process.chdir(root);
      return sync('git commit -m "Initial commit from Create Vargas NPM"', {
        stdio: "ignore",
      });
    },
  },
  {
    title: "Git remote",
    task: () => {
      process.chdir(root);
      return sync(
        `git remote add origin https:\/\/github.com\/dvargas92495\/${projectName}.git`,
        { stdio: "ignore" }
      );
    },
  },
  {
    title: "NPM version",
    task: () => {
      process.chdir(root);
      return sync(`npm version minor`, { stdio: "ignore" });
    },
  },
  {
    title: "NPM publish",
    task: () => {
      process.chdir(root);
      return sync(`npm publish`, { stdio: "ignore" });
    },
  },
]);

tasks.run().catch((err) => console.error(err));
