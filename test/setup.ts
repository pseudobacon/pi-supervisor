/**
 * Every test file in this suite installs the same guard before it can do anything:
 * no outbound HTTP, anywhere, unless that exact origin was registered by a fake server
 * that bound it first. Loopback is not an exception — the developer's pplx-proxy lives on
 * loopback. See test/helpers/network-guard.ts for what this covers and what it cannot.
 */
import { installNetworkGuard } from "./helpers/network-guard.js";

installNetworkGuard();
