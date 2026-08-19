import assert from "node:assert/strict";
import test from "node:test";
import {
  ipv4PreferredLookup,
  prefersIpv4Dns,
} from "./network-fetch.js";

test("prefers IPv4 DNS only for Glossa-controlled public endpoints", () => {
  assert.equal(prefersIpv4Dns("https://mcp.glossa.sh/healthz"), true);
  assert.equal(prefersIpv4Dns("https://registry.npmjs.org/@ariobarin%2Fglossa"), true);
  assert.equal(prefersIpv4Dns("https://github.com/ariobarin/glossa/releases"), true);
  assert.equal(prefersIpv4Dns("https://relay.example.test/healthz"), false);
  assert.equal(prefersIpv4Dns("http://127.0.0.1:39100/healthz"), false);
});

test("the preferred lookup returns IPv4 addresses", async () => {
  const addresses = await new Promise<Array<{ address: string; family: number }>>(
    (resolve, reject) => {
      ipv4PreferredLookup("localhost", { all: true }, (error, value) => {
        if (error) reject(error);
        else if (Array.isArray(value)) resolve(value);
        else reject(new Error("IPv4 lookup did not return an address list."));
      });
    },
  );

  assert.ok(addresses.length > 0);
  assert.ok(addresses.every((entry) => entry.family === 4));
});
