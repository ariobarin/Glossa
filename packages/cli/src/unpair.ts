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

  let message = "Unpaired this computer from Glossa.";
  try {
    await revoke({ relayOrigin: device.relayOrigin }, device);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    message = `Removed this computer's local Glossa pairing, but could not confirm revocation at ${device.relayOrigin}: ${reason}. Revoke it from that relay's device panel if it becomes available.`;
  }
  await remove();
  log(message);
}
