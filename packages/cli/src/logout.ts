import { loadAuthConfig } from "./auth-config.js";
import {
  deleteCredentials,
  peekCredentials,
  type LoadedCredentials,
} from "./config-store.js";
import { openBrowser } from "./open-browser.js";

export interface LogoutDependencies {
  deleteCredentials?: typeof deleteCredentials;
  peekCredentials?: typeof peekCredentials;
  openBrowser?: typeof openBrowser;
  issuer?: string;
  log?: (message: string) => void;
}

export function browserLogoutUrl(issuer: string): string {
  return new URL(
    "v2/logout",
    issuer.endsWith("/") ? issuer : `${issuer}/`,
  ).toString();
}

export async function logoutFromGlossa(
  dependencies: LogoutDependencies = {},
): Promise<void> {
  const remove = dependencies.deleteCredentials ?? deleteCredentials;
  const peek = dependencies.peekCredentials ?? peekCredentials;
  const browse = dependencies.openBrowser ?? openBrowser;
  const log = dependencies.log ?? console.log;

  let stored: LoadedCredentials | null = null;
  let present = true;
  try {
    // Use the non-migrating peek so a file-backed session is not moved into the
    // keyring (and left behind if deletion then fails) as a side effect of the
    // presence check.
    stored = await peek();
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
  const opened = await browse(url);
  if (opened) {
    log("Opened Glossa browser sign-out.");
  } else {
    log("Open this URL to finish signing out in your browser:");
    log(url);
  }
}
