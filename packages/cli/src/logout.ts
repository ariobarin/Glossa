import readline from "node:readline/promises";
import { loadAuthConfig } from "./auth-config.js";
import {
  deleteCredentials,
  loadCredentials,
  type LoadedCredentials,
} from "./config-store.js";
import { issuerEndpoint } from "./oauth.js";
import { openBrowser } from "./open-browser.js";

export interface LogoutDependencies {
  deleteCredentials?: typeof deleteCredentials;
  loadCredentials?: typeof loadCredentials;
  openBrowser?: typeof openBrowser;
  confirmBrowserSignOut?: () => Promise<boolean>;
  issuer?: string;
  log?: (message: string) => void;
}

export function browserLogoutUrl(issuer: string): string {
  return issuerEndpoint(issuer, "v2/logout");
}

async function promptBrowserSignOut(): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const prompt = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await prompt.question(
      "Press Enter to also open browser sign-out (needed to switch accounts), or type anything to skip: ",
    );
    return answer.trim() === "";
  } finally {
    prompt.close();
  }
}

export async function logoutFromGlossa(
  dependencies: LogoutDependencies = {},
): Promise<void> {
  const remove = dependencies.deleteCredentials ?? deleteCredentials;
  const load = dependencies.loadCredentials ?? loadCredentials;
  const browse = dependencies.openBrowser ?? openBrowser;
  const confirm = dependencies.confirmBrowserSignOut ?? promptBrowserSignOut;
  const log = dependencies.log ?? console.log;

  let stored: LoadedCredentials | null = null;
  let present = true;
  try {
    stored = await load();
    present = stored !== null;
  } catch {
    // Corrupt credentials stay flagged as present so remove() can clean them up.
  }

  const issuer = dependencies.issuer ?? stored?.credentials.issuer;
  // Always attempt deletion. SecureStore.load() can swallow a keyring read
  // failure and report null even when an entry still exists, so gating the
  // delete on presence would leave a credential behind. remove() is a no-op
  // when nothing is stored.
  await remove();
  log(
    present
      ? "Signed out of the Glossa account. Computer pairing stays active."
      : "Already signed out of the Glossa account. Computer pairing stays active.",
  );

  const url = browserLogoutUrl(issuer ?? loadAuthConfig().issuer);
  if (await confirm()) {
    const opened = await browse(url);
    if (opened) {
      log("Opened Glossa browser sign-out.");
      return;
    }
  }
  log(`Finish signing out in the browser when needed: ${url}`);
}
