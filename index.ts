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
const iam = new AWS.IAM({ apiVersion: "2010-05-08" });
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
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});
const rlp = (q: string) =>
  new Promise<string>((resolve) => rl.question(q, resolve));

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

const checkGhStatus = (id: string): Promise<void> =>
  axios
    .get(
      `https://api.github.com/repos/dvargas92495/${projectName}/actions/runs/${id}`
    )
    .then((r) => {
      if (r.data.status === "queued" || r.data.status === "in_progress") {
        console.log(
          chalk.yellow("Checking github action again at", new Date().toJSON())
        );
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
    title: "Write App main.yaml",
    task: () => {
      fs.mkdirSync(path.join(root, ".github", "workflows"), {
        recursive: true,
      });
      return fs.writeFileSync(
        path.join(root, ".github", "workflows", "main.yaml"),
        `name: Publish site
on:
  workflow_dispatch:
  push:
    branches: main
    paths:
      - "package.json"
      - "app/**"
      - ".github/workflows/main.yaml"

env:
  API_URL: https://api.${rawName}
  AWS_ACCESS_KEY_ID: \${{ secrets.DEPLOY_AWS_ACCESS_KEY }}
  AWS_SECRET_ACCESS_KEY: \${{ secrets.DEPLOY_AWS_ACCESS_SECRET }}
  AWS_REGION: us-east-1
  CLERK_FRONTEND_API: clerk.${DomainName}
  STRIPE_PUBLIC_KEY: \${{ secrets.STRIPE_PUBLIC_KEY }}

jobs:
  deploy:
    runs-on: ubuntu-20.04
    steps:
      - uses: actions/checkout@v2
      - name: Use Node.js 14.17.6
        uses: actions/setup-node@v1
        with:
          node-version: 14.17.6
      - name: Install NPM 8
        run: npm install -g npm@latest
      - name: install
        run: npm install
      - name: build
        run: npx fuego build
      - name: deploy
        run: npx fuego deploy${
          projectName.includes(".") ? "" : ` --domain ${rawName}`
        }
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
      - "api/**"
      - "package.json"
      - ".github/workflows/api.yaml"

env:
  API_URL: https://api.${rawName}
  AWS_ACCESS_KEY_ID: \${{ secrets.LAMBDA_AWS_ACCESS_KEY }}
  AWS_SECRET_ACCESS_KEY: \${{ secrets.LAMBDA_AWS_ACCESS_SECRET }}
  AWS_REGION: us-east-1
  CLERK_API_KEY: \${{ secrets.CLERK_API_KEY }}
  CLERK_FRONTEND_API: clerk.${DomainName}
  DATABASE_URL=mysql://${mysqlName}:\${{ secrets.MYSQL_PASSWORD }}@vargas-arts.c2sjnb5f4d57.us-east-1.rds.amazonaws.com:5432/${mysqlName}
  FE_DIR_PREFIX: /tmp
  HOST: https://${rawName}
  STRIPE_PUBLIC_KEY: \${{ secrets.STRIPE_PUBLIC_KEY }}
  STRIPE_SECRET_KEY: \${{ secrets.STRIPE_SECRET_KEY }}

jobs:
  deploy:
    runs-on: ubuntu-20.04
    steps:
      - uses: actions/checkout@v2
      - name: Use Node.js 14.17.6
        uses: actions/setup-node@v1
        with:
          node-version: 14.17.6
      - name: Install NPM 8
        run: npm install -g npm@latest
      - name: install
        run: npm install
      - name: build
        run: npx fuego compile
      - name: deploy
        run: npx fuego publish
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
      - "migrations/**"
      - ".github/workflows/db.yaml"

env:
  DATABASE_URL=mysql://${mysqlName}:\${{ secrets.MYSQL_PASSWORD }}@vargas-arts.c2sjnb5f4d57.us-east-1.rds.amazonaws.com:5432/${mysqlName}

jobs:
  deploy:
    runs-on: ubuntu-20.04
    steps:
      - uses: actions/checkout@v2
      - name: Use Node.js 14.17.6
        uses: actions/setup-node@v1
        with:
          node-version: 14.17.6
      - name: Install NPM 8
        run: npm install -g npm@latest
      - name: install
        run: npm install
      - name: migrate
        run: npx fuego migrate
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
    title: "Write pages",
    task: () => {
      fs.mkdirSync(path.join(root, "pages"));
      fs.mkdirSync(path.join(root, "pages", "_common"));
      const files = {
        "index.tsx": `import React from "react";
import Layout, { LayoutHead } from "./_common/Layout";

const Home: React.FC = () => <Layout>Welcome!</Layout>;

export const Head = () => <LayoutHead title={"Home"} />;

export default Home;
`,
        "_common/Layout.tsx": `import React from "react";
import DefaultLayout from "@dvargas92495/ui/components/Layout";
import { Head as DefaultHead } from "@dvargas92495/ui/components/Document";

const Layout: React.FC = ({ children }) => {
  return <DefaultLayout homeIcon={"Home"}>{children}</DefaultLayout>;
};

type HeadProps = Omit<Parameters<typeof DefaultHead>[0], "title">;

export const LayoutHead = ({
  title = "Welcome",
  ...rest
}: HeadProps & { title?: string }): React.ReactElement => {
  return (
    <DefaultHead title={\`\${title} | ${
      safeProjectName.split("-")[0]
    }\`} {...rest} />
  );
};

export default Layout;`,
        "login.tsx": `import React from "react";
import { SignIn } from "@clerk/clerk-react";
import Layout, { LayoutHead } from "./_common/Layout";

const LoginPage: React.FC = () => (
  <Layout>
    <SignIn />
  </Layout>
);

export const Head = (): React.ReactElement => <LayoutHead title={"Log In"} />;
export default LoginPage;
`,
        "signup.tsx": `import React from "react";
import Layout, { LayoutHead } from "./_common/Layout";
import { SignUp } from "@clerk/clerk-react";

const Signup: React.FunctionComponent = () => (
  <Layout>
    <SignUp />
  </Layout>
);

export const Head = (): React.ReactElement => <LayoutHead title={"Sign up"} />;
export default Signup;
`,
        "user.tsx": `import React from "react";
import Layout, { LayoutHead } from "./_common/Layout";
import RedirectToLogin from "@dvargas92495/ui/components/RedirectToLogin";
import clerkUserProfileCss from "@dvargas92495/ui/clerkUserProfileCss";
import { SignedIn, UserProfile } from "@clerk/clerk-react";

const UserPage: React.FunctionComponent = () => (
  <Layout>
    <SignedIn>
      <UserProfile />
    </SignedIn>
    <RedirectToLogin />
  </Layout>
);

export const Head = (): React.ReactElement => (
  <LayoutHead
    title={"User"}
    styles={clerkUserProfileCss}
  />
);
export default UserPage;`,
        "about.tsx": `import React from "react";
import Layout, { LayoutHead } from "./_common/Layout";
import About from "@dvargas92495/ui/components/About";

const AboutPage: React.FunctionComponent = () => (
  <Layout>
    <About
      title={"About"}
      subtitle={"Description"}
      paragraphs={[]}
    />
  </Layout>
);

export const Head = (): React.ReactElement => <LayoutHead title={"About"} />;
export default AboutPage;
`,
        "contact.tsx": `import React from "react";
import Layout, { LayoutHead } from "./_common/Layout";
import Contact from "@dvargas92495/ui/components/Contact";

const ContactPage: React.FunctionComponent = () => (
  <Layout>
    <Contact email={"${
      safeProjectName.includes("-")
        ? `support@${projectName}`
        : "dvargas92495@gmail.com"
    }"} />
  </Layout>
);

export const Head = (): React.ReactElement => <LayoutHead title={"Contact Us"} />;
export default ContactPage;
`,
        "privacy-policy.tsx": `import React from "react";
import Layout, { LayoutHead } from "./_common/Layout";
import PrivacyPolicy from "@dvargas92495/ui/components/PrivacyPolicy";

const PrivacyPolicyPage: React.FunctionComponent = () => (
  <Layout>
    <PrivacyPolicy name={"${safeProjectName}"} domain={"${rawName}"} />
  </Layout>
);

export const Head = (): React.ReactElement => (
  <LayoutHead title={"Privacy Policy"} />
);
export default PrivacyPolicyPage;`,
        "terms-of-use.tsx": `import React from "react";
import Layout, { LayoutHead } from "./_common/Layout";
import TermsOfUse from "@dvargas92495/ui/components/TermsOfUse";

const TermsOfUsePage: React.FC = () => (
  <Layout>
    <TermsOfUse name={"${safeProjectName}"} domain={"${rawName}"} />
  </Layout>
);

export const Head = (): React.ReactElement => (
  <LayoutHead title={"Terms of Use"} />
);
export default TermsOfUsePage;`,
        "_html.tsx": `export * from "@dvargas92495/ui/components/FuegoRoot";
export { default as default } from "@dvargas92495/ui/components/FuegoRoot";`,
      };
      return Object.entries(files).forEach(([file, content]) =>
        fs.writeFileSync(path.join(root, "pages", file), content)
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

variable "mysql_password" {
  type = string
}

variable "stripe_public" {
  type = string
}

variable "stripe_secret" {
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
  version = "3.2.0"

  domain = "${projectName.includes(".") ? projectName : rawName}"
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
  version = "2.2.1"

  api_name = "${safeProjectName}"${
            safeProjectName.includes("-")
              ? ""
              : `\n  domain  = "${safeProjectName}.davidvargas.me"`
          }
}

module "aws_clerk" {
  source   = "dvargas92495/clerk/aws"
  version  = "1.0.4"

  zone_id  = module.aws_static_site.route53_zone_id
  clerk_id = "${process.env.CLERK_DNS_ID}"${
            safeProjectName.includes("-")
              ? ""
              : `\n  subdomain  = "${safeProjectName}"`
          }
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

resource "github_actions_secret" "mysql_password" {
  repository       = "${projectName}"
  secret_name      = "MYSQL_PASSWORD"
  plaintext_value  = var.mysql_password
}

resource "github_actions_secret" "clerk_api_key" {
  repository       = "${projectName}"
  secret_name      = "CLERK_API_KEY"
  plaintext_value  = var.clerk_api_key
}

resource "github_actions_secret" "stripe_public" {
  repository       = "${projectName}"
  secret_name      = "STRIPE_PUBLIC_KEY"
  plaintext_value  = var.stripe_public
}

resource "github_actions_secret" "stripe_secret" {
  repository       = "${projectName}"
  secret_name      = "STRIPE_SECRET_KEY"
  plaintext_value  = var.stripe_secret
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
          Authorization: `Bearer ${process.env.TERRAFORM_ORGANIZATION_TOKEN}`,
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
              { key: "clerk_api_key", env: "CLERK_API_KEY" },
              { key: "stripe_public", env: "LIVE_STRIPE_PUBLIC" },
              { key: "stripe_secret", env: "LIVE_STRIPE_SECRET" },
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
                      status === "applying" ||
                      status === "plan_queued"
                    ) {
                      console.log(
                        chalk.yellow(
                          "Checking terraform run again at",
                          new Date().toJSON()
                        )
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
              return checkTerraformStatus();
            })
            .catch((e) => {
              console.log(
                chalk.yellow(
                  `Failed to kick off the terraform run. Do so manually. Error:`
                )
              );
              console.log(chalk.yellow(e));
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
HOST=http://localhost:3000
CLERK_API_KEY=${process.env.CLERK_DEV_API_KEY}
CLERK_FRONTEND_API=${process.env.CLERK_DEV_FRONTEND_API}
STRIPE_PUBLIC_KEY=${process.env.TEST_STRIPE_PUBLIC}
STRIPE_SECRET_KEY=${process.env.TEST_STRIPE_SECRET}
DATABASE_URL=mysql://${mysqlName}:${mysqlName}@localhost:5432/${mysqlName}
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
        chalk.blue(
          "- Setup Google Project on https://console.cloud.google.com/projectselector2/home/dashboard?organizationId=0"
        )
      );
      console.log(
        chalk.blue(
          `- Create OauthClient id on https://console.cloud.google.com/apis/credentials?project=${safeProjectName}`
        )
      );
      console.log(
        chalk.blue("- Click Deploy on the Clerk Production Instance")
      );
      console.log(chalk.blue("- Copy "));
    },
    skip: () => !isApp,
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
    .catch((e) => console.error(chalk.redBright(e)))
    .finally(() => rl.close());
}
