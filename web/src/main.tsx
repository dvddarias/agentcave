import { QueryClientProvider } from "@tanstack/react-query";
import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router";
import { Layout } from "./components/Layout";
import { Spinner } from "./components/ui";
import { queryClient } from "./lib/api";
import { AgentsPage } from "./pages/AgentsPage";
import { CyclePage } from "./pages/CyclePage";
import { CyclesPage } from "./pages/CyclesPage";
import "./index.css";

// Pages with the code editor (CodeMirror) and rarely used pages load on demand.
const AgentEditorPage = lazy(() =>
  import("./pages/AgentEditorPage").then((m) => ({ default: m.AgentEditorPage })),
);
const PlaygroundPage = lazy(() =>
  import("./pages/PlaygroundPage").then((m) => ({ default: m.PlaygroundPage })),
);
const DocsPage = lazy(() => import("./pages/DocsPage").then((m) => ({ default: m.DocsPage })));
const SettingsPage = lazy(() => import("./pages/SettingsPage").then((m) => ({ default: m.SettingsPage })));
const UsagePage = lazy(() => import("./pages/UsagePage").then((m) => ({ default: m.UsagePage })));

const load = (el: React.ReactNode) => (
  <Suspense
    fallback={
      <div className="flex justify-center py-16 text-cave-400">
        <Spinner />
      </div>
    }
  >
    {el}
  </Suspense>
);

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { index: true, element: <Navigate to="/cycles" replace /> },
      { path: "cycles", element: <CyclesPage /> },
      { path: "cycles/:id", element: <CyclePage /> },
      { path: "playground", element: load(<PlaygroundPage />) },
      { path: "agents", element: <AgentsPage /> },
      { path: "agents/new", element: load(<AgentEditorPage />) },
      { path: "agents/:slug", element: load(<AgentEditorPage />) },
      { path: "usage", element: load(<UsagePage />) },
      { path: "docs", element: load(<DocsPage />) },
      { path: "settings", element: load(<SettingsPage />) },
      {
        path: "*",
        element: <div className="py-20 text-center text-cave-400">This page does not exist in the cave.</div>,
      },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
