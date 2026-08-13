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

  await revoke({ relayOrigin: device.relayOrigin }, device);
  await remove();
  log("Unpaired this computer from Glossa.");
}
