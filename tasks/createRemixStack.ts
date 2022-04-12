import { createApp } from "@remix-run/dev/cli/create";
import fs from "fs";
import path from "path";
import { build as esbuild } from "esbuild";

const createRemixStack = ({ projectDir }: { projectDir: string }) => {
  const packageJson = JSON.parse(fs.readFileSync("./package.json").toString());
  const remixVersion = (
    packageJson.dependencies["@remix-run/dev"] || ""
  ).replace(/^[~\^]/, "");
  return createApp({
    appTemplate: "template",
    projectDir: path.resolve(process.cwd(), projectDir),
    remixVersion,
    installDeps: true,
    useTypeScript: true,
    githubToken: process.env.GITHUB_TOKEN,
  }).then(async () => {
    console.log("💿 Running remix.init script");
    let initScriptDir = path.join(projectDir, "remix.init");
    const outfile = path.resolve(initScriptDir, "index.js");
    await esbuild({
      entryPoints: [path.resolve(initScriptDir, "index.ts")],
      bundle: true,
      platform: "node",
      outfile,
    });
    const initFn = require(outfile).default;

    try {
      await initFn({
        rootDirectory: projectDir,
      });
    } catch (error) {
      console.error(`🚨 Oops, remix.init failed`);
      throw error;
    }
    fs.rmSync(initScriptDir, { force: true, recursive: true });
  });
};

export default createRemixStack;
