# Pearlet

A self-custody mobile wallet for Pearl (PRL), built with React Native for iPhone and Android. Send and Receive use Mainnet by default. The Testnet2 switch in Settings opens a separate test wallet with valueless coins.

[pearlet.io](https://pearlet.io) · [Privacy policy](https://pearlet.io/privacy)

## Run locally

Use Node.js 22.18 or later and the standard [React Native native toolchain](https://reactnative.dev/docs/set-up-your-environment). Android needs JDK 17 and the SDK and NDK versions in `android/build.gradle`. iOS needs Xcode and CocoaPods.

```sh
npm ci
npm test
npm run typecheck
```

Install pods for iOS:

```sh
bundle install
bundle exec pod install --project-directory=ios
```

Start Metro with `npm start`. In another terminal run `npm run ios` or `npm run android` with a simulator or device connected. On Xcode 27, boot a simulator in Device Hub before running the iOS app.

## Wallet behavior

- Pearlet uses device randomness and stores the recovery phrase in Keychain or Keystore-protected storage. The operating system authenticates the user before signing, revealing the recovery phrase, or retrying a broadcast. Android 11 or later is required, so the phrase's Keystore key itself demands device authentication. While a recovery phrase is shown or typed, Android blocks screenshots and recording, iOS hides it during recording or mirroring and accepts the system keyboard only, and the phrase can be copied only where the clipboard hides it (iOS, Android 13 and later).
- Setup requires three randomly chosen words from the backup. Settings can verify the complete phrase against the saved wallet. Restore validates the phrase, previews the recovered addresses, and can compare them to a known public address before saving.
- Pearlet uses plain Taproot profiles. The receive address is at `m/86'/808276'/0'/0/0` on Mainnet and `m/86'/1'/0'/0/0` on Testnet2. Mainnet’s dedicated **Mining payouts** address uses index 1. Both Mainnet addresses contribute to the same balance and activity. Fresh receive addresses start at index 2. Change goes to the next unused index and the receive address moves past it, so a send does not tie the first address to the rest; a wallet without a saved watch key still returns change to index 0. Restore finds these addresses with a 20-address gap scan.
- The app ID is `dev.atmospherelabs.pearlet` on iOS and Android.
- An existing Testnet2 wallet keeps its address and pending transfer journal. Open it with device authentication to upgrade protection on the original phrase. A Mainnet wallet has its own profile, phrase, and journal.
- The hosted indexers serve address activity, UTXOs, fee estimates, and transaction relay. Pearlet queries public addresses and signs transactions locally before submitting signed bytes to the selected indexer. The indexer operator therefore sees all of a wallet's addresses together with the device's IP address, and relay results come from that one source. [Mainnet Blockbook](https://blockbook.pearlnetwork.net/api/v2) · [Testnet2 Blockbook](https://blockbook.testnet2.pearlnetwork.net/api/v2)
- Send verifies raw previous outputs against the transaction ID, amount, and wallet script. It spends confirmed outputs, enforces mining reward maturity, and rejects addresses from the other network. Retry uses the same signed bytes if the relay result is uncertain.
- Settings has App lock (device authentication after 30 seconds in the background), Hide balance (also toggled by tapping the balance), a Mining payouts toggle, Haptics, and About with version, network and indexer. **Remove wallet from this device** appears only after a verified backup with no pending transfer. It requires typing REMOVE and device authentication, and deletes only that network's phrase, profile and journal.
- iOS keeps Keychain entries when an app is deleted. On first launch Pearlet checks for wallets left by an earlier install and asks whether to keep them (with device authentication) or erase them. The wallet list is rebuilt from the Keychain at every launch, so a saved wallet always has an entry to open it.
- The mining payout address is for a separate miner or pool. [Pearl mining guide](https://help.pearlresearch.ai/hc/en-us/articles/49191239541905-How-mining-on-Pearl-works)

Illustration credit and the original ImageGen prompt are in [the asset credits](assets/credits.md).

## Security

Please report vulnerabilities privately to contact@atmospherelabs.dev rather than in a public issue.

## License

[MIT](LICENSE) © 2026 Atmosphere Labs
