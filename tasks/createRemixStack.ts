import { create } from "@remix-run/dev/cli/commands";
import fs from "fs";

const createRemixStack = ({ projectDir }: { projectDir: string }) => {
  const packageJson = JSON.parse(fs.readFileSync("./package.json").toString());
  const remixVersion = (
    packageJson.dependencies["@remix-run/dev"] || ""
  ).replace(/^[~\^]/, "");
  return create({
    appTemplate: "template",
    projectDir,
    remixVersion,
    installDeps: true,
    useTypeScript: true,
    githubToken: process.env.GITHUB_TOKEN,
  }).then(() => {
    console.log(fs.readdirSync(projectDir));
  });
};

export default createRemixStack;
