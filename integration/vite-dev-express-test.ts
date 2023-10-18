import fs from "node:fs/promises";
import path from "node:path";
import { test, expect } from "@playwright/test";
import getPort from "get-port";

import { createFixtureProject, js } from "./helpers/create-fixture.js";
import { kill, node } from "./helpers/dev.js";

let projectDir: string;
let dev: { pid: number; port: number };

// TODO: need to set an HMR (websocket) port to avoid conflicts
// note that this is different from the server port

test.beforeAll(async () => {
  let port = await getPort();
  projectDir = await createFixtureProject({
    compiler: "vite",
    files: {
      "vite.config.mjs": js`
        import { defineConfig } from "vite";
        import { unstable_vitePlugin as remix } from "@remix-run/dev";

        export default defineConfig({
          optimizeDeps: {
            include: ["react", "react-dom/client"],
          },
          plugins: [remix()],
        });
      `,
      "server.mjs": js`
        import {
          unstable_createViteServer,
          unstable_loadViteServerBuild,
        } from "@remix-run/dev";
        import { createRequestHandler } from "@remix-run/express";
        import { installGlobals } from "@remix-run/node";
        import express from "express";

        installGlobals();

        let vite =
          process.env.NODE_ENV === "production"
            ? undefined
            : await unstable_createViteServer();

        const app = express();

        if (vite) {
          app.use(vite.middlewares);
        } else {
          app.use(
            "/build",
            express.static("public/build", { immutable: true, maxAge: "1y" })
          );
        }
        app.use(express.static("public", { maxAge: "1h" }));

        app.all(
          "*",
          createRequestHandler({
            build: vite
              ? () => unstable_loadViteServerBuild(vite)
              : await import("./build/index.js"),
          })
        );

        const port = ${port};
        app.listen(port, async () => {
          console.log('Express server listening on port ' + port);
        });
      `,
      "app/root.tsx": js`
        import { Links, Meta, Outlet, Scripts, LiveReload } from "@remix-run/react";

        export default function Root() {
          return (
            <html lang="en">
              <head>
                <Meta />
                <Links />
              </head>
              <body>
                <div id="content">
                  <h1>Root</h1>
                  <Outlet />
                </div>
                <LiveReload />
                <Scripts />
              </body>
            </html>
          );
        }
      `,
      "app/routes/_index.tsx": js`
        import { useState, useEffect } from "react";

        export default function IndexRoute() {
          const [mounted, setMounted] = useState(false);
          useEffect(() => {
            setMounted(true);
          }, []);

          return (
            <div id="index">
              <h2 data-title>Index</h2>
              <input key="state" />
              <p data-mounted>Mounted: {mounted ? "yes" : "no"}</p>
              <p data-hmr>HMR updated: no</p>
            </div>
          );
        }
      `,
    },
  });
  dev = await node(projectDir, ["./server.mjs"], { port });
  console.log({ projectDir });
});

test.afterAll(async () => {
  await kill(dev.pid);
});

test("Vite custom server HMR & HDR", async ({ page }) => {
  // setup: initial render
  await page.goto(`http://localhost:${dev.port}/`, {
    waitUntil: "networkidle",
  });
  await expect(page.locator("#index [data-title]")).toHaveText("Index");

  // setup: hydration
  await expect(page.locator("#index [data-mounted]")).toHaveText(
    "Mounted: yes"
  );

  // setup: browser state
  let hmrStatus = page.locator("#index [data-hmr]");
  await expect(hmrStatus).toHaveText("HMR updated: no");
  let input = page.locator("#index input");
  await expect(input).toBeVisible();
  await input.type("stateful");

  // route: HMR
  let indexRouteContents = await fs.readFile(
    path.join(projectDir, "app/routes/_index.tsx"),
    "utf8"
  );
  await fs.writeFile(
    path.join(projectDir, "app/routes/_index.tsx"),
    indexRouteContents.replace("HMR updated: no", "HMR updated: yes"),
    "utf8"
  );
  await page.waitForLoadState("networkidle");
  await expect(hmrStatus).toHaveText("HMR updated: yes");
  await expect(input).toHaveValue("stateful");

  // route: add loader
  await fs.writeFile(
    path.join(projectDir, "app/routes/_index.tsx"),
    js`
      import { useState, useEffect } from "react";
      import { json } from "@remix-run/node";
      import { useLoaderData } from "@remix-run/react";

      export const loader = () => {
        return json({ message: "hello" });
      }

      export default function IndexRoute() {
        const [mounted, setMounted] = useState(false);
        useEffect(() => {
          setMounted(true);
        }, []);
        const { message } = useLoaderData<typeof loader>();

        return (
          <div id="index">
            <h2 data-title>Index</h2>
            <input key="state" />
            <p data-mounted>Mounted: {mounted ? "yes" : "no"}</p>
            <p data-hmr>{message}</p>
          </div>
        );
      }
    `,
    "utf8"
  );
  await page.waitForLoadState("networkidle");
  await expect(hmrStatus).toHaveText("hello");

  // React Fast Refresh cannot preserve state for a component when hooks are added or removed
  await expect(input).toHaveValue("");
  await input.type("stateful");

  // route: HDR
  await transformFile("app/routes/_index.tsx", (contents) =>
    contents.replace("hello", "goodbye")
  );
  await page.waitForLoadState("networkidle");
  await expect(hmrStatus).toHaveText("goodbye");
  await expect(input).toHaveValue("stateful");

  await transformFile("app/routes/_index.tsx", (contents) =>
    contents
      .replace(`json({ message: "goodbye" })`, `json({ msg: "gbye" })`)
      .replace(
        "const { message } = useLoaderData",
        "const { msg } = useLoaderData"
      )
      .replace("<p data-hmr>{message}</p>", "<p data-hmr>{msg}</p>")
  );
  await page.waitForLoadState("networkidle");
  await expect(hmrStatus).toHaveText("gbye");
  // React Refresh cannot preserve state for a component when destructuring result of changed hooks
  await expect(input).toHaveValue("");
  await input.type("stateful");

  // route: HMR + HDR
  // await transformFile("app/routes/_index.tsx", (contents) =>
  //   contents
  //     // loader
  //     .replace(`json({ msg: "goodbye" })`, `json({ msg: "howdy y'all" })`)
  //     // useLoaderData
  //     .replace(
  //       "const { message } = useLoaderData",
  //       "const { msg } = useLoaderData"
  //     )
  //     // JSX
  //     .replace("<h2 data-title>Index</h2>", "<h2 data-title>Howdy</h2>")
  //     .replace("<p data-hmr>{message}</p>", "<p data-hmr>{msg}</p>")
  // );
  // await page.waitForLoadState("networkidle");
  // await expect(page.locator("#index [data-title]")).toHaveText("Howdy");
  // await expect(hmrStatus).toHaveText("howdy y'all");
  // await expect(input).toHaveValue("stateful");

  // non-route: HMR
  // non-route: HDR

  // TODO: remove debug expect
  await expect(input).toHaveValue("chewbacca");
});

async function transformFile(
  file: string,
  transform: (contents: string) => string
) {
  let contents = await fs.readFile(path.join(projectDir, file), "utf8");
  await fs.writeFile(path.join(projectDir, file), transform(contents), "utf8");
}
