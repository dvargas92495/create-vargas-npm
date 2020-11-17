#!/usr/bin/env node
import validateNpmName from "validate-npm-package-name";
import chalk from "chalk";
import fs from "fs";
import path from "path";
import os from "os";
import { sync } from "cross-spawn";
import cpy from "cpy";
import sodium from "tweetsodium";
import axios from "axios";

const npmToken = process.env.NPM_TOKEN || "";

const projectName = process.argv[2];
const run = async () => {
  console.log("Creating app...", chalk.green(projectName));
  console.log();

  const { validForNewPackages, errors, warnings } = validateNpmName(
    projectName
  );
  if (!validForNewPackages) {
    console.error(
      `Could not create a project called ${chalk.red(
        `"${projectName}"`
      )} because of npm naming restrictions:`
    );

    errors?.forEach((p) => console.error(`    ${chalk.red.bold("*")} ${p}`));
    warnings?.forEach((p) =>
      console.warn(`    ${chalk.yellow.bold("*")} ${p}`)
    );
    process.exit(1);
  }

  const root = path.resolve(projectName);
  fs.mkdirSync(projectName);

  const packageJson = {
    name: projectName,
    description: `Description for ${projectName}`,
    version: "0.0.0",
    main: "dist/index.js",
    types: "lib/index.d.ts",
    scripts: {
      build: "tsc",
      format: 'prettier --write "src/**/*.tsx"',
      lint: "tslint -p tsconfig.json",
      prepare: "npm run build",
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

  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify(packageJson, null, 2) + os.EOL
  );

  fs.writeFileSync(
    path.join(root, "README.md"),
    `# ${projectName}

Description for ${projectName}
`
  );

  await sync("cd", [projectName]);
  await sync(
    "npm install --save --save-dev @testing-library/jest-dom @testing-library/react @testing-library/user-event @types/jest @types/react @types/react-dom jest prettier ts-jest tslint tslint-config-prettier tslint-react-hooks typescript"
  );
  await sync("npm install --save react react-dom");

  await cpy("**", root, {
    parents: true,
    cwd: path.join(__dirname, "template"),
  });

  if (npmToken) {
    console.log("Adding npm token secret");
    // https://docs.github.com/en/free-pro-team@latest/rest/reference/actions#example-encrypting-a-secret-using-nodejs
    const messageBytes = Buffer.from(npmToken);
    const githubOpts = {
      headers: {
        Authorization: `token ${process.env.GITHUB_TOKEN}`,
      },
    };
    const {
      data: { key },
    } = await axios.get(
      `https://api.github.com/repos/dvargas92495/${projectName}/actions/secrets/public-key`,
      githubOpts
    );
    const keyBytes = Buffer.from(key, "base64");
    const encryptedBytes = sodium.seal(messageBytes, keyBytes);
    const encrypted_value = Buffer.from(encryptedBytes).toString("base64");
    await axios.put(
      `https://api.github.com/repos/dvargas92495/${projectName}/actions/secrets/NPM_TOKEN`,
      {
        encrypted_value,
      },
      githubOpts
    );
  } else {
    console.warn("Did not set npm token, skipping...");
  }

  await sync("git init", { stdio: "ignore" });
  await sync("git add -A", { stdio: "ignore" });
  await sync('git commit -m "Initial commit from Create Vargas NPM"', {
    stdio: "ignore",
  });
  await sync(
    `git remote add origin https://github.com/dvargas92495/${projectName}.git`
  );
  await sync("npm version minor");
};

run();
