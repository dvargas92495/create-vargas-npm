import remixAppLoader from "@dvargas92495/app/utils/remixAppLoader.server";
import { Outlet } from "@remix-run/react";

export const loader = remixAppLoader;
export default Outlet;
