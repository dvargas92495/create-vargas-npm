import RemixRoot, {
  getRootLinks,
  getRootMeta,
  RootCatchBoundary,
} from "@dvargas92495/ui/components/RemixRoot";
import remixRootLoader from "@dvargas92495/ui/utils/remixRootLoader.server";
import styles from "./tailwind.css";

export const loader = remixRootLoader;
export const meta = getRootMeta({ title: "{{{displayName}}}" });
export const links = getRootLinks([{ rel: "stylesheet", href: styles }]);
export const CatchBoundary = RootCatchBoundary;
export default RemixRoot;