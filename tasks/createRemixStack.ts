import { create } from "@remix-run/dev/cli/commands";
import fs from "fs";
import path from "path";

const createRemixStack = ({ projectDir }: { projectDir: string }) => {
  const packageJson = JSON.parse(fs.readFileSync("./package.json").toString());
  const remixVersion = (
    packageJson.dependencies["@remix-run/dev"] || ""
  ).replace(/^[~\^]/, "");
  return create({
    appTemplate: "template",
    projectDir: path.resolve(process.cwd(), projectDir),
    remixVersion,
    installDeps: true,
    useTypeScript: true,
    githubToken: process.env.GITHUB_TOKEN,
  }).then(() => {
    console.log(fs.readdirSync(projectDir));
    const view = { projectName: "TODO" };
  });
};

export default createRemixStack;
