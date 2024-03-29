#!/usr/bin/env node
import validateNpmName from "validate-npm-package-name";
import chalk from "chalk";
import fs from "fs";
import path from "path";
import os from "os";
import spawn, { sync } from "cross-spawn";
import sodium from "tweetsodium";
import axios from "axios";
import meow from "meow";

const helpText = `
${chalk.red("F")} ${chalk.redBright("U")} ${chalk.yellow(
  "E"
)} ${chalk.redBright("G")} ${chalk.red("O")}
${chalk.blue("Usage")}:
  $ npx fuego init <${chalk.green("projectName")}>
${chalk.blue("Options")}:
  --help, -h          Print this help message and exit
  --version, -v       Print the CLI version and exit
  --task              Run just the input task. Runs all when omitted
  --react             Project created will use React and JSX
  --app               Project created will be a full stack application
`;

const npmToken = process.env.NPM_TOKEN || "";

const rawName = process.argv[2] || "";
const projectName = rawName
  .replace(/^@dvargas92495\//, "")
  .replace(/\.davidvargas\.me$/, "");

const argv = process.argv.slice(3);
const { flags, showHelp, showVersion } = meow(helpText, {
  argv,
  booleanDefault: undefined,
  description: false,
  flags: {
    help: { type: "string", alias: "h" },
    react: { type: "boolean" },
    task: { type: "string" },
    version: { type: "boolean", alias: "v" },
  },
});
if (flags.help) showHelp();
if (flags.version) showVersion();

const isReact = flags.react;
const root = path.resolve(projectName);
const githubOpts = {
  headers: {
    Authorization: `token ${process.env.GITHUB_TOKEN}`,
  },
};

type Task = {
  title: string;
  task: () => void | Promise<void>;
  skip?: () => boolean;
};
const tasks: Task[] = [
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
    skip: () => fs.existsSync(projectName),
  },
  {
    title: "Write Package JSON",
    task: () => {
      const packageJson: any = {
        name: rawName,
        description: `Description for ${rawName}`,
        version: "0.0.0",
        license: "MIT",
        repository: `dvargas92495/${projectName}`,
        sideEffects: false,
        main: "dist/index.js",
        types: "dist/index.d.ts",
        scripts: {
          prebuild: "cross-env NODE_ENV=test npm t",
          build: "tsc",
          format: `prettier --write "src/**/*.ts${isReact ? "x" : ""}"`,
          lint: `eslint . --ext .ts${isReact ? ",.tsx" : ""}`,
          prepublishOnly: "npm run build",
          preversion: "npm run lint",
          version: "npm run format && git add -A src",
          postversion: "git push origin main && git push --tags",
          pretest: "npm run lint",
          test: "jest --config jestconfig.json",
        },
        files: [""],
        ...(isReact
          ? {
              peerDependencies: {
                react: "^16.8.0 || ^17",
                "react-dom": "^16.8.0 || ^17",
              },
            }
          : {}),
      };

      return fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify(packageJson, null, 2) + os.EOL
      );
    },
  },
  {
    title: "Write Jest Config",
    task: () => {
      const jestConfig = {
        transform: {
          "^.+\\.(t|j)sx?$": "ts-jest",
        },
        testRegex: "/tests/.*\\.test\\.tsx?$",
        moduleFileExtensions: ["ts", "tsx", "js", "jsx"],
        ...(isReact
          ? {
              setupFilesAfterEnv: ["@testing-library/jest-dom/extend-expect"],
            }
          : {}),
      };

      return fs.writeFileSync(
        path.join(root, "jestconfig.json"),
        JSON.stringify(jestConfig, null, 2) + os.EOL
      );
    },
  },
  {
    title: "Write tsconfig.json",
    task: () => {
      const tsconfig = {
        compilerOptions: {
          jsx: "react",
          target: "es2015",
          allowJs: false,
          lib: ["es2019", "dom", "dom.iterable"],
          module: "commonjs",
          moduleResolution: "node",
          declaration: true,
          outDir: ".",
          strict: true,
          esModuleInterop: true,
          noUnusedLocals: true,
          noUnusedParameters: true,
          noImplicitReturns: true,
          noImplicitThis: true,
          noImplicitAny: true,
          forceConsistentCasingInFileNames: true,
          allowSyntheticDefaultImports: true,
          skipLibCheck: true,
        },
        include: ["src"],
        exclude: ["node_modules", "**/__tests__/*"],
      };

      return fs.writeFileSync(
        path.join(root, "tsconfig.json"),
        JSON.stringify(tsconfig, null, 2) + os.EOL
      );
    },
  },
  {
    title: "Write package main.yaml",
    task: () => {
      fs.mkdirSync(path.join(root, ".github", "workflows"), {
        recursive: true,
      });
      return fs.writeFileSync(
        path.join(root, ".github", "workflows", "main.yaml"),
        `name: Publish package
on:
  push:
    branches: main
    paths:
      - "package.json"

jobs:
  deploy:
    runs-on: ubuntu-20.04
    steps:
      - uses: actions/checkout@v2
      - name: Use Node.js 14.17.6
        uses: actions/setup-node@v1
        with:
          node-version: 14.17.6
      - name: install
        run: npm install
      - uses: JS-DevTools/npm-publish@v1
        with:
          token: \${{ secrets.NPM_TOKEN }}
          access: "public"
          check-version: false
`
      );
    },
  },
  {
    title: "Write .gitignore",
    task: () => {
      return fs.writeFileSync(
        path.join(root, ".gitignore"),
        `node_modules
build
dist
out
.env
`
      );
    },
  },
  {
    title: "Write .eslintrc.json",
    task: () => {
      const eslintrc = {
        root: true,
        parser: "@typescript-eslint/parser",
        plugins: ["@typescript-eslint"],
        extends: [
          "eslint:recommended",
          "plugin:@typescript-eslint/eslint-recommended",
          "plugin:@typescript-eslint/recommended",
        ],
        ignorePatterns: ["**/*", "scripts/"],
      };
      return fs.writeFileSync(
        path.join(root, ".eslintrc.json"),
        JSON.stringify(eslintrc, null, 2) + os.EOL
      );
    },
  },
  {
    title: "Write LICENSE",
    task: () => {
      return fs.writeFileSync(
        path.join(root, "LICENSE"),
        `MIT License

Copyright (c) ${new Date().getFullYear()} David Vargas

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`
      );
    },
  },
  {
    title: "Install Dev Packages",
    task: () => {
      process.chdir(root);
      return new Promise<void>((resolve, reject) => {
        const dependencies = [
          "@types/jest",
          "@typescript-eslint/parser",
          "@typescript-eslint/eslint-plugin",
          "cross-env",
          "eslint",
          "jest",
          "prettier",
          "ts-jest",
          "tslint-config-prettier",
          "typescript",
          ...(isReact
            ? [
                "@testing-library/jest-dom",
                "@testing-library/react",
                "@testing-library/user-event",
                "@types/react",
                "@types/react-dom",
                "tslint-react-hooks",
              ]
            : []),
        ];
        const child = spawn(
          "npm",
          ["install", "--save-dev"].concat(dependencies),
          {
            stdio: "inherit",
          }
        );
        child.on("close", (code) => {
          if (code !== 0) {
            reject(code);
            return;
          }
          resolve();
        });
      });
    },
  },
  {
    title: "Install Packages",
    skip: () => !isReact,
    task: () => {
      process.chdir(root);
      return new Promise<void>((resolve, reject) => {
        const dependencies = ["react", "react-dom"];
        const child = spawn("npm", ["install"].concat(dependencies), {
          stdio: "inherit",
        });
        child.on("close", (code) => {
          if (code !== 0) {
            reject(code);
            return;
          }
          resolve();
        });
      });
    },
  },
  {
    title: "Write src",
    task: () => {
      fs.mkdirSync(path.join(root, "src"));
      if (isReact) {
        return fs.writeFileSync(
          path.join(root, "src", "index.tsx"),
          `import React from "react";

const Package: React.FunctionComponent = () => <div>Fill out component!</div>;

export default Package;
`
        );
      } else {
        return fs.writeFileSync(
          path.join(root, "src", "index.ts"),
          `const run = (): number => {
  return 0;
};

export default run;
`
        );
      }
    },
  },
  {
    title: "Write tests",
    task: () => {
      fs.mkdirSync(path.join(root, "tests"));
      if (isReact) {
        return fs.writeFileSync(
          path.join(root, "tests", "index.test.tsx"),
          `import React from 'react';
import Package from '../src';
import { render } from '@testing-library/react';

test('Renders Package', () => {
  const { container } = render(<Package/>);
  expect(container).toBeInTheDocument();
});
`
        );
      } else {
        return fs.writeFileSync(
          path.join(root, "tests", "index.test.ts"),
          `import run from "../src";

test("Runs Default", () => {
  expect(run()).toBe(0);
});
`
        );
      }
    },
  },
  {
    title: "Create a github repo",
    task: () => {
      return axios
        .get(`https://api.github.com/repos/dvargas92495/${projectName}`)
        .then(() => console.log(chalk.yellow("Repo already exists.")))
        .catch((e) =>
          e.response?.status === 404
            ? axios
                .post(
                  "https://api.github.com/user/repos",
                  {
                    name: projectName,
                  },
                  githubOpts
                )
                .catch((err) =>
                  console.log(
                    chalk.red("Failed to create repo", err.response?.data)
                  )
                )
            : console.log(chalk.red("Failed to check repo", e.response?.data))
        );
    },
    skip: () => !process.env.GITHUB_TOKEN,
  },
  {
    title: "Add NPM Token",
    task: () => {
      // https://docs.github.com/en/free-pro-team@latest/rest/reference/actions#example-encrypting-a-secret-using-nodejs
      const messageBytes = Buffer.from(npmToken);
      return axios
        .get(
          `https://api.github.com/repos/dvargas92495/${projectName}/actions/secrets/public-key`,
          githubOpts
        )
        .then(({ data: { key, key_id } }) => {
          const keyBytes = Buffer.from(key, "base64");
          const encryptedBytes = sodium.seal(messageBytes, keyBytes);
          const encrypted_value = Buffer.from(encryptedBytes).toString(
            "base64"
          );
          return axios.put(
            `https://api.github.com/repos/dvargas92495/${projectName}/actions/secrets/NPM_TOKEN`,
            {
              encrypted_value,
              key_id,
            },
            githubOpts
          );
        })
        .catch((e) =>
          console.log(
            chalk.red(
              "Failed to add secret",
              typeof e.response?.data === "object"
                ? JSON.stringify(e.response?.data)
                : e.response?.data
            )
          )
        );
    },
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
      return new Promise<void>((resolve, reject) => {
        const child = spawn(
          "git",
          [
            "remote",
            "add",
            "origin",
            `https://github.com/dvargas92495/${projectName}.git`,
          ],
          {
            stdio: "inherit",
          }
        );
        child.on("close", (code) => {
          if (code !== 0) {
            reject(code);
            return;
          }
          resolve();
        });
      });
    },
  },
  {
    title: "NPM version",
    task: () => {
      process.chdir(root);
      return new Promise<void>((resolve, reject) => {
        const child = spawn("npm", ["version", "patch"], {
          stdio: "inherit",
        });
        child.on("close", (code) => {
          if (code !== 0) {
            reject(code);
            return;
          }
          resolve();
        });
      });
    },
  },
];

const runTask = (
  task: Task
): Promise<{ success: boolean; message?: string }> => {
  console.log(chalk.blue("Running", task.title, "..."));
  if (task.skip?.()) {
    console.log(chalk.blueBright("Skipped", task.title));
    return Promise.resolve({ success: true });
  }
  return Promise.resolve(task.task)
    .then((t) => t())
    .then(() => {
      console.log(chalk.greenBright("Successfully Ran", task.title));
      return { success: true as const };
    })
    .catch((e) => {
      console.log(chalk.redBright("Failed to run", task.title));
      return { success: false as const, message: e.message };
    });
};

const run = async () => {
  for (const task of tasks) {
    const result = await runTask(task);
    if (!result.success) {
      const rest = tasks.slice(tasks.indexOf(task) + 1);
      rest.forEach((r) =>
        console.log(
          chalk.grey(
            "Skipped task",
            r.title,
            "due to failure from previous task"
          )
        )
      );
      return Promise.reject(result.message);
    }
  }
};

if (flags.task) {
  const task = tasks.find((t) => t.title === flags.task);
  if (task)
    runTask(task).then((s) =>
      s.success
        ? console.log(chalk.green("Done!"))
        : console.error(chalk.redBright(s.message))
    );
  else
    console.error(chalk.redBright(`Failed to find task of name ${flags.task}`));
} else {
  run()
    .then(() => console.log(chalk.greenBright(`${projectName} is Ready!`)))
    .catch((e) => console.error(chalk.redBright(e)));
}
