import { useEffect, useState } from "react";
import { LogsPage } from "./LogsPage";
import { HomePage } from "./HomePage";

function useLocationPath(): string {
  const [path, setPath] = useState<string>(() => window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    // Light-weight pushState patch so navigate() can update without reload.
    const origPush = history.pushState;
    history.pushState = function (this: History, ...args) {
      const ret = origPush.apply(this, args);
      setPath(window.location.pathname);
      return ret;
    } as typeof history.pushState;
    return () => {
      window.removeEventListener("popstate", onPop);
      history.pushState = origPush;
    };
  }, []);
  return path;
}

export function navigate(to: string): void {
  history.pushState({}, "", to);
}

export function App() {
  const path = useLocationPath();

  // /logs/:key
  const m = path.match(/^\/logs\/([^/]+)\/?$/);
  if (m) {
    const key = decodeURIComponent(m[1]!);
    return <LogsPage logKey={key} />;
  }
  return <HomePage />;
}
