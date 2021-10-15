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
import readline from "readline";

AWS.config.credentials = new AWS.SharedIniFileCredentials({
  profile: "davidvargas",
});
const iam = new AWS.IAM({ apiVersion: "2010-05-08" });
const route53 = new AWS.Route53({ apiVersion: "2013-04-01" });
const domains = new AWS.Route53Domains({
  apiVersion: "2014-05-15",
});
const rds = new AWS.RDS({ apiVersion: "2014-10-31" });
const npmToken = process.env.NPM_TOKEN || "";
const terraformOrganizationToken = process.env.TERRAFORM_ORGANIZATION_TOKEN;
const rawName = process.argv[2] || "";
const projectName = rawName
  .replace(/^@dvargas92495\//, "")
  .replace(/\.davidvargas\.me$/, "");
const safeProjectName = projectName.replace(/\./g, "-");
const mysqlName = safeProjectName.replace(/-/g, "_");
const opts = process.argv.slice(3);
const isReact = opts.includes("--react");
const isApp = rawName.includes(".") || opts.includes("--app");
const root = path.resolve(projectName);
const githubOpts = {
  headers: {
    Authorization: `token ${process.env.GITHUB_TOKEN}`,
  },
};
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});
const rlp = (q: string) =>
  new Promise<string>((resolve) => rl.question(q, resolve));

const getHostedZoneIdByName = async (domain: string) => {
  let finished = false;
  let props: { Marker?: string } = {};
  while (!finished) {
    const {
      HostedZones,
      IsTruncated,
      NextMarker,
    } = await route53.listHostedZones(props).promise();
    const zone = HostedZones.find((i) => i.Name === `${domain}.`);
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
    .checkDomainAvailability({ DomainName: projectName })
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
        console.log(chalk.yellow("Checking again at", new Date().toJSON()));
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

const checkGhStatus = (id: string): Promise<void> =>
  axios
    .get(
      `https://api.github.com/repos/dvargas92495/${projectName}/actions/runs/${id}`
    )
    .then((r) => {
      if (r.data.status === "queued" || r.data.status === "in_progress") {
        console.log(chalk.yellow("Checking again at", new Date().toJSON()));
        return new Promise((resolve) =>
          setTimeout(() => resolve(checkGhStatus(id)), 30000)
        );
      } else if (r.data.status === "completed") {
        console.log(chalk.green("Site deployed at", new Date().toJSON()));
        return;
      } else {
        console.log(chalk.red(r.data.status));
        throw new Error("Failed to deploy site. aborting...");
      }
    });

const tasks: {
  title: string;
  task: () => void | Promise<void>;
  skip?: () => boolean;
}[] = [
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
      const DomainName = rawName.split(".").slice(-2).join(".");
      return getHostedZoneIdByName(DomainName).then((id) => {
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
        ...(isApp
          ? {
              scripts: {
                format: `prettier --write "**/*.tsx"`,
                lint: `eslint . --ext .ts,.tsx`,
                api: "fuego api",
                build: "fuego build",
                compile: "fuego compile",
                deploy: "fuego deploy",
                fe: "fuego fe",
                migrate: "npm run typeorm migration:run",
                publish: "fuego publish",
                typeorm:
                  "ts-node --transpile-only ./node_modules/typeorm/cli.js",
              },
            }
          : {
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
              files: ["/dist"],
              ...(isReact
                ? {
                    peerDependencies: {
                      react: "^16.8.0 || ^17",
                      "react-dom": "^16.8.0 || ^17",
                    },
                  }
                : {}),
            }),
      };
      if (isApp) {
        fs.writeFileSync(
          path.join(root, "fuego.json"),
          JSON.stringify({ renderBodyFirst: true }, null, 2) + os.EOL
        );
      }

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
          outDir: "./dist",
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
    title: "Write App main.yaml",
    task: () => {
      fs.mkdirSync(path.join(root, ".github", "workflows"), {
        recursive: true,
      });
      return fs.writeFileSync(
        path.join(root, ".github", "workflows", "main.yaml"),
        `name: Publish site
on:
  push:
    branches: main
    paths:
      - "package.json"
      - "src/**"
      - "pages/**"
      - ".github/workflows/main.yaml"

env:
  API_URL: https://api.${projectName}
  AWS_ACCESS_KEY_ID: \${{ secrets.DEPLOY_AWS_ACCESS_KEY }}
  AWS_SECRET_ACCESS_KEY: \${{ secrets.DEPLOY_AWS_ACCESS_SECRET }}
  AWS_REGION: us-east-1
  CLERK_FRONTEND_API: clerk.${projectName}

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
      - name: build
        run: npm run build
      - name: deploy
        run: npm run deploy
`
      );
    },
    skip: () => !isApp,
  },
  {
    title: "Write api.yaml",
    task: () => {
      return fs.writeFileSync(
        path.join(root, ".github", "workflows", "api.yaml"),
        `name: Publish API
on:
  push:
    branches: main
    paths:
      - "functions/**"
      - "src/**"
      - "package.json"
      - ".github/workflows/api.yaml"

env:
  AWS_ACCESS_KEY_ID: \${{ secrets.LAMBDA_AWS_ACCESS_KEY }}
  AWS_SECRET_ACCESS_KEY: \${{ secrets.LAMBDA_AWS_ACCESS_SECRET }}
  AWS_REGION: us-east-1
  CLERK_API_KEY: \${{ secrets.CLERK_API_KEY }}
  TYPEORM_CONNECTION: mysql
  TYPEORM_HOST: vargas-arts.c2sjnb5f4d57.us-east-1.rds.amazonaws.com
  TYPEORM_USERNAME: ${mysqlName}
  TYPEORM_PASSWORD: \${{ secrets.MYSQL_PASSWORD }}
  TYPEORM_DATABASE: ${mysqlName}
  TYPEORM_PORT: 5432
  TYPEORM_SYNCHRONIZE: false
  TYPEORM_LOGGING: false
  TYPEORM_ENTITIES: db/*.ts
  TYPEORM_MIGRATIONS: db/migrations/*.ts
  TYPEORM_MIGRATIONS_DIR: db/migrations

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
      - name: build
        run: npm run compile
      - name: deploy
        run: npm run publish
`
      );
    },
    skip: () => !isApp,
  },
  {
    title: "Write db.yaml",
    task: () => {
      return fs.writeFileSync(
        path.join(root, ".github", "workflows", "db.yaml"),
        `name: Migrate DB
on:
  push:
    branches: main
    paths:
      - "db/**"
      - ".github/workflows/db.yaml"

env:
  TYPEORM_CONNECTION: mysql
  TYPEORM_HOST: vargas-arts.c2sjnb5f4d57.us-east-1.rds.amazonaws.com
  TYPEORM_USERNAME: ${mysqlName}
  TYPEORM_PASSWORD: \${{ secrets.MYSQL_PASSWORD }}
  TYPEORM_DATABASE: ${mysqlName}
  TYPEORM_PORT: 5432
  TYPEORM_SYNCHRONIZE: false
  TYPEORM_LOGGING: false
  TYPEORM_ENTITIES: db/*.ts
  TYPEORM_MIGRATIONS: db/migrations/*.ts
  TYPEORM_MIGRATIONS_DIR: db/migrations

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
      - name: migrate
        run: npm run migrate
`
      );
    },
    skip: () => !isApp,
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
_fuego
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
        ignorePatterns: ["**/dist/*", "scripts/"],
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
          "@typescript-eslint/parser",
          "@typescript-eslint/eslint-plugin",
          "eslint",
          "prettier",
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
          ...(isApp
            ? [
                "@types/node",
                "@types/aws-lambda",
                "@types/react",
                "@types/react-dom",
                "fuegojs",
                "ts-node",
                "tslint-react-hooks",
              ]
            : ["@types/jest", "cross-env", "jest", "ts-jest"]),
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
    task: () => {
      process.chdir(root);
      return new Promise<void>((resolve, reject) => {
        const dependencies = isApp
          ? ["@dvargas92495/api", "@dvargas92495/ui", "aws-sdk-plus", "axios"]
          : ["react", "react-dom"];
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
    skip: () => !isReact && !isApp,
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
    title: "Write pages",
    task: () => {
      fs.mkdirSync(path.join(root, "pages"));
      return fs.writeFileSync(
        path.join(root, "pages", "index.tsx"),
        `import React from "react";

const Home: React.FunctionComponent = () => <div>Welcome!</div>;

export default Home;
`
      );
    },
    skip: () => !isApp,
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
    title: "Set up Clerk",
    task: () => {
      return rlp(
        `Create an application on https://dashboard.clerk.dev/applications called ${projectName}. Press enter when done.`
      )
        .then(() =>
          rlp("Enter the developer api key:").then(
            (k) => (process.env.CLERK_DEV_API_KEY = k)
          )
        )
        .then(() =>
          rlp("Enter the developer clerk frontend API url:").then(
            (k) => (process.env.CLERK_DEV_FRONTEND_API = k)
          )
        )
        .then(() =>
          console.log(
            chalk.blue(
              "Check on custom urls in redirect config. Then create production instance on same settings.\nCurrently, there's a Clerk bug where you have to duplicate this work in production."
            )
          )
        )
        .then(() =>
          rlp("Enter the production api key:").then(
            (k) => (process.env.CLERK_API_KEY = k)
          )
        )
        .then(() =>
          rlp("Enter the clerk production id, found on the DNS page:").then(
            (k) => (process.env.CLERK_DNS_ID = k)
          )
        );
    },
    skip: () => !isApp,
  },
  {
    title: "Write main.tf",
    task: () => {
      return Promise.resolve(
        fs.writeFileSync(
          path.join(root, "main.tf"),
          `terraform {
  backend "remote" {
    hostname = "app.terraform.io"
    organization = "VargasArts"
    workspaces {
      prefix = "${safeProjectName}"
    }
  }
  required_providers {
    github = {
      source = "integrations/github"
      version = "4.2.0"
    }
  }
}

variable "aws_access_token" {
  type = string
}

variable "aws_secret_token" {
  type = string
}

variable "github_token" {
  type = string
}

variable "secret" {
  type = string
}

variable "clerk_api_key" {
    type = string
}

provider "aws" {
  region = "us-east-1"
  access_key = var.aws_access_token
  secret_key = var.aws_secret_token
}

provider "github" {
  owner = "dvargas92495"
  token = var.github_token
}

module "aws_static_site" {
  source  = "dvargas92495/static-site/aws"
  version = "3.1.3"

  domain = "${projectName}"
  secret = var.secret
  tags = {
      Application = "${safeProjectName}"
  }

  providers = {
    aws.us-east-1 = aws
  }
}

module "aws-serverless-backend" {
    source  = "dvargas92495/serverless-backend/aws"
    version = "2.0.5"

    api_name = "${safeProjectName}"
}

module "aws_clerk" {
  source   = "dvargas92495/clerk/aws"
  version  = "1.0.1"

  zone_id  = module.aws_static_site.route53_zone_id
  clerk_id = "${process.env.CLERK_DNS_ID}"
}

resource "github_actions_secret" "deploy_aws_access_key" {
  repository       = "${projectName}"
  secret_name      = "DEPLOY_AWS_ACCESS_KEY"
  plaintext_value  = module.aws_static_site.deploy-id
}

resource "github_actions_secret" "deploy_aws_access_secret" {
  repository       = "${projectName}"
  secret_name      = "DEPLOY_AWS_ACCESS_SECRET"
  plaintext_value  = module.aws_static_site.deploy-secret
}

resource "github_actions_secret" "lambda_aws_access_key" {
  repository       = "${projectName}"
  secret_name      = "LAMBDA_AWS_ACCESS_KEY"
  plaintext_value  = module.aws-serverless-backend.access_key
}

resource "github_actions_secret" "lambda_aws_access_secret" {
  repository       = "${projectName}"
  secret_name      = "LAMBDA_AWS_ACCESS_SECRET"
  plaintext_value  = module.aws-serverless-backend.secret_key
}

resource "github_actions_secret" "clerk_api_key" {
  repository       = "${projectName}"
  secret_name      = "CLERK_API_KEY"
  plaintext_value  = var.clerk_api_key
}
`
        )
      );
    },
    skip: () => !isApp,
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
                  { name: projectName },
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
    skip: () => isApp,
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
    skip: () => isApp,
  },
  {
    title: "Git push",
    task: () => {
      process.chdir(root);
      return sync(`git push origin main`, { stdio: "ignore" });
    },
    skip: () => !isApp,
  },
  {
    title: "Create Site Manager",
    task: () => {
      return iam
        .createUser({
          UserName: safeProjectName,
        })
        .promise()
        .then(() =>
          Promise.all([
            iam
              .addUserToGroup({
                UserName: safeProjectName,
                GroupName: "static-site-managers",
              })
              .promise(),
            ...[
              "arn:aws:iam::aws:policy/AWSLambda_FullAccess",
              "arn:aws:iam::aws:policy/AmazonAPIGatewayAdministrator",
              "arn:aws:iam::aws:policy/AmazonDynamoDBFullAccess",
              "arn:aws:iam::aws:policy/AmazonSESFullAccess",
            ].map((PolicyArn) =>
              iam
                .attachUserPolicy({
                  UserName: safeProjectName,
                  PolicyArn,
                })
                .promise()
            ),
          ])
        )
        .then(() =>
          iam.createAccessKey({ UserName: safeProjectName }).promise()
        )
        .then((creds) => {
          process.env.AWS_ACCESS_KEY_ID = creds.AccessKey.AccessKeyId;
          process.env.AWS_SECRET_ACCESS_KEY = creds.AccessKey.SecretAccessKey;
          fs.appendFileSync(
            path.resolve(`${process.env.HOME}/.aws/credentials`),
            `[${safeProjectName}]\naws_access_key_id = ${creds.AccessKey.AccessKeyId}\naws_secret_access_key = ${creds.AccessKey.SecretAccessKey}\n`
          );
          console.log(
            chalk.green("Successfully created keys for", safeProjectName)
          );
          return;
        });
    },
    skip: () => !isApp,
  },
  {
    title: "Create Workspace And Kick off Run",
    task: () => {
      const tfOpts = {
        headers: {
          Authorization: `Bearer ${terraformOrganizationToken}`,
          "Content-Type": "application/vnd.api+json",
        },
      };
      const userTfOpts = {
        ...tfOpts,
        headers: {
          ...tfOpts.headers,
          Authorization: `Bearer ${process.env.TERRAFORM_USER_TOKEN}`,
        },
      };
      return axios
        .get<{
          data: { attributes: { "service-provider": string }; id: string }[];
        }>(
          "https://app.terraform.io/api/v2/organizations/VargasArts/oauth-clients",
          tfOpts
        )
        .then(
          (r) =>
            r.data.data.find(
              (cl) => cl.attributes["service-provider"] === "github"
            )?.id
        )
        .then((id) =>
          axios
            .get(
              `https://app.terraform.io/api/v2/oauth-clients/${id}/oauth-tokens`,
              tfOpts
            )
            .then((r) => r.data.data[0].id)
        )
        .then((id) =>
          axios
            .post(
              "https://app.terraform.io/api/v2/organizations/VargasArts/workspaces",
              {
                data: {
                  type: "workspaces",
                  attributes: {
                    name: safeProjectName,
                    "auto-apply": true,
                    "vcs-repo": {
                      "oauth-token-id": id,
                      identifier: `dvargas92495/${projectName}`,
                    },
                  },
                },
              },
              tfOpts
            )
            .then((r) => r.data.data.id)
        )
        .then((id) =>
          Promise.all(
            [
              { key: "aws_access_token", env: "AWS_ACCESS_KEY_ID" },
              { key: "aws_secret_token", env: "AWS_SECRET_ACCESS_KEY" },
              { key: "secret", value: randomstring.generate(32) },
              { key: "github_token", env: "GITHUB_TOKEN" },
              { key: "mysql_password", env: "MYSQL_PASSWORD" },
            ].map(({ key, env, value }) =>
              axios.post(
                `https://app.terraform.io/api/v2/workspaces/${id}/vars`,
                {
                  data: {
                    type: "vars",
                    attributes: {
                      key,
                      sensitive: true,
                      category: "terraform",
                      value: value || (env && process.env[env]),
                    },
                  },
                },
                tfOpts
              )
            )
          )
            .then(() =>
              axios.post(
                `https://app.terraform.io/api/v2/runs`,
                {
                  data: {
                    attributes: {
                      message: "Kicking off first run",
                    },
                    type: "runs",
                    relationships: {
                      workspace: {
                        data: {
                          type: "workspaces",
                          id,
                        },
                      },
                    },
                  },
                },
                userTfOpts
              )
            )
            .then((r) => {
              const runId = r.data.data.id;
              console.log(chalk.green(`Successfully kicked off run ${runId}`));
              const checkTerraformStatus = (): Promise<void> =>
                axios
                  .get(
                    `https://app.terraform.io/api/v2/runs/${runId}`,
                    userTfOpts
                  )
                  .then((d) => {
                    const { status } = d.data.data.attributes;
                    if (
                      status === "pending" ||
                      status === "planning" ||
                      status === "applying"
                    ) {
                      console.log(
                        chalk.yellow("Checking again at", new Date().toJSON())
                      );
                      return new Promise((resolve) =>
                        setTimeout(() => resolve(checkTerraformStatus()), 30000)
                      );
                    } else if (status === "applied") {
                      console.log(
                        chalk.green(
                          "Resources successfully created at",
                          new Date().toJSON()
                        )
                      );
                      return;
                    } else {
                      console.log(
                        chalk.red(JSON.stringify(d.data.data.attributes))
                      );
                      throw new Error(
                        "Failed to create resources. aborting..."
                      );
                    }
                  });
            })
        );
    },
    skip: () => !isApp,
  },
  {
    title: "Write .env",
    task: () => {
      return Promise.resolve(
        fs.writeFileSync(
          path.join(root, ".env"),
          `API_URL=http://localhost:3003
CLERK_API_KEY=${process.env.CLERK_DEV_API_KEY}
CLERK_FRONTEND_API=${process.env.CLERK_DEV_FRONTEND_API}
TYPEORM_CONNECTION=mysql
TYPEORM_HOST=localhost
TYPEORM_USERNAME=${mysqlName}
TYPEORM_PASSWORD=${mysqlName}
TYPEORM_DATABASE=${mysqlName}
TYPEORM_PORT=5432
TYPEORM_SYNCHRONIZE=false
TYPEORM_LOGGING=true
TYPEORM_ENTITIES=db/*.ts
TYPEORM_MIGRATIONS=db/migrations/*.ts
TYPEORM_MIGRATIONS_DIR=db/migrations
`
        )
      );
    },
    skip: () => !isApp,
  },
  {
    title: "Kick off first action",
    task: () =>
      axios
        .post(
          `https://api.github.com/repos/dvargas92495/${projectName}/actions/workflows/main.yaml/dispatches`,
          { ref: "main" },
          githubOpts
        )
        .then(
          () =>
            new Promise((resolve) =>
              setTimeout(
                () =>
                  resolve(
                    axios
                      .get(
                        `https://api.github.com/repos/dvargas92495/${projectName}/actions/runs`
                      )
                      .then((r) => checkGhStatus(r.data.workflow_runs[0].id))
                  ),
                10000
              )
            )
        ),
    skip: () => !isApp,
  },
  {
    title: "Manual Steps to run",
    task: () => {
      console.log(chalk.blue("Manual steps to run:"));
      console.log(
        chalk.blue("- Click Deploy on the Clerk Production Instance")
      );
    },
    skip: () => !isApp,
  },
];

const run = async () => {
  for (const task of tasks) {
    console.log(chalk.blue("Running", task.title, "..."));
    if (task.skip?.()) {
      console.log(chalk.blueBright("Skipped", task.title));
      continue;
    }
    const result = await Promise.resolve(task.task)
      .then((t) => t())
      .then(() => {
        console.log(chalk.greenBright("Successfully Ran", task.title));
        return { success: true as const };
      })
      .catch((e) => {
        console.log(chalk.redBright("Failed to run", task.title));
        return { success: false as const, message: e.message };
      });
    if (!result.success) {
      return Promise.reject(result.message);
    }
  }
};

run()
  .then(() => rl.close())
  .then(() => console.log(chalk.greenBright(`${projectName} Ready!`)))
  .catch((e) => console.error(chalk.redBright(e)));
