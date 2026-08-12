import {
  deleteDeviceCredential,
  loadDeviceCredential,
} from "./device-store.js";
import {
  loadRelayEndpoints,
  revokePairedDevice,
} from "./relay-client.js";

export interface UnpairDependencies {
  loadDeviceCredential?: typeof loadDeviceCredential;
  deleteDeviceCredential?: typeof deleteDeviceCredential;
  loadRelayEndpoints?: typeof loadRelayEndpoints;
  revokePairedDevice?: typeof revokePairedDevice;
  log?: (message: string) => void;
}

export async function unpairComputer(
  dependencies: UnpairDependencies = {},
): Promise<void> {
  const load = dependencies.loadDeviceCredential ?? loadDeviceCredential;
  const remove = dependencies.deleteDeviceCredential ?? deleteDeviceCredential;
  const endpointsFor = dependencies.loadRelayEndpoints ?? loadRelayEndpoints;
  const revoke = dependencies.revokePairedDevice ?? revokePairedDevice;
  const log = dependencies.log ?? console.log;

  const device = await load();
  if (!device) {
    log("This computer is not paired with Glossa.");
    return;
  }

  const endpoints = endpointsFor();
  if (device.relayOrigin === endpoints.relayOrigin) {
    await revoke(endpoints, device);
  }
  await remove();
  log("Unpaired this computer from Glossa.");
}
