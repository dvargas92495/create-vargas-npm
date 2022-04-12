#!/usr/bin/env node
import validateNpmName from "validate-npm-package-name";
import chalk from "chalk";
import fs from "fs";
import path from "path";
import os from "os";
import spawn, { sync } from "cross-spawn";
import sodium from "tweetsodium";
import axios from "axios";
import randomstring from "randomstring";
import AWS from "aws-sdk";
import mysql from "mysql";
import createRemixStack from "./tasks/createRemixStack";
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

AWS.config.credentials = new AWS.SharedIniFileCredentials({
  profile: "davidvargas",
});
const route53 = new AWS.Route53({ apiVersion: "2013-04-01" });
const domains = new AWS.Route53Domains({
  apiVersion: "2014-05-15",
});
const rds = new AWS.RDS({ apiVersion: "2014-10-31" });
const npmToken = process.env.NPM_TOKEN || "";

const rawName = process.argv[2] || "";
const projectName = rawName
  .replace(/^@dvargas92495\//, "")
  .replace(/\.davidvargas\.me$/, "");
const safeProjectName = projectName.replace(/\./g, "-");
const mysqlName = safeProjectName.replace(/-/g, "_");
const DomainName = rawName.split(".").slice(-2).join(".");

const argv = process.argv.slice(3);
const { flags, showHelp, showVersion } = meow(helpText, {
  argv,
  booleanDefault: undefined,
  description: false,
  flags: {
    app: { type: "boolean" },
    help: { type: "string", alias: "h" },
    react: { type: "boolean" },
    task: { type: "string" },
    version: { type: "boolean", alias: "v" },
  },
});
if (flags.help) showHelp();
if (flags.version) showVersion();

const isReact = flags.react;
const isApp = rawName.includes(".") || flags.app || false;
const root = path.resolve(projectName);
const githubOpts = {
  headers: {
    Authorization: `token ${process.env.GITHUB_TOKEN}`,
  },
};

const getHostedZoneIdByName = async () => {
  let finished = false;
  let props: { Marker?: string } = {};
  while (!finished) {
    const {
      HostedZones,
      IsTruncated,
      NextMarker,
    } = await route53.listHostedZones(props).promise();
    const zone = HostedZones.find((i) => i.Name === `${DomainName}.`);
    if (zone) {
      return zone.Id.replace(/\/hostedzone\//, "");
    }
    finished = !IsTruncated;
    props = { Marker: NextMarker };
  }

  return null;
};

const checkAvailability = (): Promise<string> =>
  domains
    .checkDomainAvailability({ DomainName })
    .promise()
    .then((r) =>
      r.Availability === "PENDING" ? checkAvailability() : r.Availability
    );

const checkDomainStatus = (OperationId: string): Promise<void> =>
  domains
    .getOperationDetail({ OperationId })
    .promise()
    .then((d) => {
      if (d.Status === "IN_PROGRESS" || d.Status === "SUBMITTED") {
        console.log(
          chalk.yellow(
            "Checking domain registration again at",
            new Date().toJSON()
          )
        );
        return new Promise((resolve) =>
          setTimeout(() => resolve(checkDomainStatus(OperationId)), 30000)
        );
      } else if (d.Status === "SUCCESSFUL") {
        console.log(
          chalk.green("Domain successfully registered at", new Date().toJSON())
        );
        return;
      } else {
        console.log(chalk.red(JSON.stringify(d)));
        throw new Error("Failed to register domain. aborting...");
      }
    });

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
    skip: () => isApp,
  },
  {
    title: "Verify site ownership",
    task: () => {
      return getHostedZoneIdByName().then((id) => {
        if (id) {
          return console.log(
            chalk.yellow(
              "Already own domain in hosted zone",
              id,
              "moving on..."
            )
          );
        }
        return checkAvailability().then((r) => {
          if (r !== "AVAILABLE") {
            return domains
              .getDomainSuggestions({
                DomainName,
                OnlyAvailable: true,
                SuggestionCount: 10,
              })
              .promise()
              .then((s) => {
                throw new Error(
                  `Domain ${DomainName} is not available and not owned (${r}), try one of these:\n${s.SuggestionsList?.map(
                    (s) => `- ${s.DomainName}`
                  )}\naborting...`
                );
              });
          }
          console.log(chalk.blue("Buying domain", DomainName));
          const {
            AddressLine1 = "",
            AddressLine2 = "",
            City = "",
            State = "",
            ZipCode = "",
            PhoneNumber = "",
          } = JSON.parse(process.env.CONTACT_DETAIL || "{}");
          if (
            !AddressLine1 ||
            !AddressLine2 ||
            !City ||
            !State ||
            !ZipCode ||
            !PhoneNumber
          ) {
            throw new Error(
              "Invalid Address entered in CONTACT_DETAIL stringified JSON env variable"
            );
          }
          const Contact = {
            ContactType: "PERSON",
            CountryCode: "US",
            Email: "dvargas92495@gmail.com",
            FirstName: "David",
            LastName: "Vargas",
            AddressLine1,
            AddressLine2,
            City,
            PhoneNumber,
            State,
            ZipCode,
          };
          return domains
            .registerDomain({
              TechContact: Contact,
              RegistrantContact: Contact,
              AdminContact: Contact,
              DomainName,
              DurationInYears: 1,
            })
            .promise()
            .then((r) => {
              console.log(
                chalk.green(
                  "Successfully bought",
                  DomainName,
                  "operation id:",
                  r.OperationId
                )
              );
              return checkDomainStatus(r.OperationId);
            });
        });
      });
    },
    skip: () => !isApp,
  },
  {
    title: "Create RDS DB",
    task: () =>
      rds
        .describeDBInstances({ DBInstanceIdentifier: "vargas-arts" })
        .promise()
        .then((r) => {
          if (!r.DBInstances?.length)
            throw new Error("Could not find main RDS instance");
          const { Address, Port } = r.DBInstances[0].Endpoint || {};
          const connection = mysql.createConnection({
            host: Address,
            port: Port,
            user: "dvargas92495",
            password: process.env.RDS_MASTER_PASSWORD,
          });
          connection.connect();
          process.env.MYSQL_PASSWORD = randomstring.generate(16);
          process.env.MYSQL_HOST = Address;
          process.env.MYSQL_PORT = `${Port}`;
          return new Promise((resolve) =>
            connection.query(`CREATE DATABASE ${mysqlName}`, resolve)
          )
            .then(
              () =>
                new Promise((resolve) =>
                  connection.query(
                    `CREATE USER '${mysqlName}'@'%' IDENTIFIED BY '${process.env.MYSQL_PASSWORD}'`,
                    resolve
                  )
                )
            )
            .then(
              () =>
                new Promise((resolve) =>
                  connection.query(
                    `GRANT ALL PRIVILEGES ON ${mysqlName} . * TO '${mysqlName}'@'%'`,
                    resolve
                  )
                )
            )
            .then(
              () =>
                new Promise((resolve) =>
                  connection.query(`FLUSH PRIVILEGES`, resolve)
                )
            )
            .then(() => connection.end());
        }),
    skip: () => !isApp,
  },
  {
    title: "Create local DB",
    task: () => {
      const connection = mysql.createConnection({
        host: "localhost",
        port: 5432,
        user: "root",
        password: process.env.LOCAL_MYSQL_PASSWORD,
      });
      connection.connect();
      return new Promise((resolve) =>
        connection.query(`CREATE DATABASE ${mysqlName}`, resolve)
      )
        .then(
          () =>
            new Promise((resolve) =>
              connection.query(
                `CREATE USER '${mysqlName}'@'%' IDENTIFIED BY '${mysqlName}'`,
                resolve
              )
            )
        )
        .then(
          () =>
            new Promise((resolve) =>
              connection.query(
                `GRANT ALL PRIVILEGES ON ${mysqlName} . * TO '${mysqlName}'@'%'`,
                resolve
              )
            )
        )
        .then(
          () =>
            new Promise((resolve) =>
              connection.query(`FLUSH PRIVILEGES`, resolve)
            )
        )
        .then(() => connection.end());
    },
    skip: () => !isApp,
  },
  {
    title: "Make Project Directory",
    task: () => fs.mkdirSync(projectName),
    skip: () => isApp || fs.existsSync(projectName),
  },
  {
    title: "Create Remix Stack",
    task: () => createRemixStack({ projectDir: projectName }),
    skip: () => !isApp,
  },
  {
    title: "Write Package JSON",
    skip: () => isApp,
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
    skip: () => isApp,
  },
  {
    title: "Write tsconfig.json",
    skip: () => isApp,
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
        include: ["src", ...(isApp ? ["pages", "functions", "db"] : [])],
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
    skip: () => isApp,
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
    skip: () => isApp,
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
    skip: () => isApp,
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
    skip: () => isApp,
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
    skip: () => isApp || !isReact,
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
    skip: () => isApp,
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
    skip: () => isApp,
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
                    ...(isApp ? { homepage: rawName } : {}),
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
    skip: () => !process.env.GITHUB_TOKEN || isApp,
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
    skip: () => isApp,
  },
  {
    title: "Git init",
    skip: () => isApp,
    task: () => {
      process.chdir(root);
      return sync("git init", { stdio: "ignore" });
    },
  },
  {
    title: "Git add",
    skip: () => isApp,
    task: () => {
      process.chdir(root);
      return sync("git add -A", { stdio: "ignore" });
    },
  },
  {
    title: "Git commit",
    skip: () => isApp,
    task: () => {
      process.chdir(root);
      return sync('git commit -m "Initial commit from Create Vargas NPM"', {
        stdio: "ignore",
      });
    },
  },
  {
    title: "Git remote",
    skip: () => isApp,
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
    skip: () => isApp,
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
    runTask(task)
      .then((s) =>
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
