import {
  deleteDeviceCredential,
  loadDeviceCredential,
} from "./device-store.js";
import {
  revokePairedDevice,
} from "./relay-client.js";

export interface UnpairDependencies {
  loadDeviceCredential?: typeof loadDeviceCredential;
  deleteDeviceCredential?: typeof deleteDeviceCredential;
  revokePairedDevice?: typeof revokePairedDevice;
  log?: (message: string) => void;
}

export async function unpairComputer(
  dependencies: UnpairDependencies = {},
): Promise<void> {
  const load = dependencies.loadDeviceCredential ?? loadDeviceCredential;
  const remove = dependencies.deleteDeviceCredential ?? deleteDeviceCredential;
  const revoke = dependencies.revokePairedDevice ?? revokePairedDevice;
  const log = dependencies.log ?? console.log;

  const device = await load();
  if (!device) {
    log("This computer is not paired with Glossa.");
    return;
  }

  let revokeError: unknown;
  try {
    await revoke({ relayOrigin: device.relayOrigin }, device);
  } catch (error) {
    revokeError = error;
  }
  await remove();
  if (revokeError === undefined) {
    log("Unpaired this computer from Glossa.");
    return;
  }

  const reason = revokeError instanceof Error ? revokeError.message : String(revokeError);
  log(
    `Removed this computer's local Glossa pairing, but could not confirm revocation at ${device.relayOrigin}: ${reason}. Revoke it from that relay's device panel if it becomes available.`,
  );
}
