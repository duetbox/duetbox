# DuetBox

DuetBox is a mod of [UltraBox](https://github.com/ultraabox/ultrabox_typescript) for making music with friends in real time.
UltraBox is a modification of [JummBox](https://github.com/jummbus/jummbox), which in turn is a modification of the [original BeepBox](https://beepbox.co).

Everything UltraBox does still works, and songs are regular UltraBox song URLs, so they open in UltraBox too.

## Duet rooms

1. Click **Duet**, then **Create room**.
2. Send the link (or the 8-character code) to your friends.
3. They open the link and click **Join room**.

Everyone edits the same song from their own computer or phone, and sees each other's changes as they happen.
You can see each other's mouse pointers, and a colored outline shows which pattern each person is working on.

- Undo only undoes your own edits, not other people's.
- If the person who created the room leaves, someone else takes over automatically and the room keeps going.
- Leaving a room keeps the song in your editor. Joining a room replaces the song you had open; you can get it back from **File → Recover Recent Song**.

### How it works

Rooms are peer to peer. DuetBox uses [Trystero](https://github.com/dmotz/trystero) to find the other people in a room through public [Nostr](https://nostr.com) relays, then connects everyone directly with WebRTC.
Only the connection handshakes pass through the relays, and they're encrypted with the room code; the song itself goes straight between browsers.

One person in the room (whoever created it, or whoever took over) holds the official copy of the song. Everyone else sends their edits there, and the merged result goes back out to everyone.
Edits are merged piece by piece: song settings, channel names, instruments, sequence cells, and individual notes. So two people can work on different things, or even on the same pattern, at the same time without losing each other's work.
Only when two people change the very same thing at once does one of the changes win.

If you can't connect from a strict school or work network, open **Connection settings** in the Duet window and add a TURN server. You can also choose your own Nostr relays there; everyone in a room needs the same relays.

## Compiling

The code is written in [TypeScript](https://www.typescriptlang.org/), which requires
[node & npm](https://www.npmjs.com/get-npm), so install those first. Then to build
this project, open a command line ([Git Bash](https://gitforwindows.org/)) and run:

```
git clone https://github.com/shrimpsooup2/duetbox
cd duetbox
npm install
npm run build
```

Then open `website/index.html` (served from a local web server, e.g. `npx serve website`, because WebRTC and the Web Crypto API need `http://localhost` or HTTPS).

Like JummBox and UltraBox, DuetBox uses the [select2](https://select2.org) library for some menus, which depends on [jQuery](https://jquery.com).
If they aren't picked up automatically, install them with:

```
npm install select2
npm install @types/select2
npm install @types/jquery
```

### Vendored dependencies

Trystero and [noble-secp256k1](https://github.com/paulmillr/noble-secp256k1) (which Trystero's Nostr support needs) are copied into [vendor/](vendor) rather than installed from npm.
They're compiled together with the editor by the normal build, so nothing extra is needed. To update them, change the versions at the top of
[scripts/vendor_trystero.sh](scripts/vendor_trystero.sh) and run it.

## Code

The code is divided into several folders, like in BeepBox.

The [synth/](synth) folder has just the code you need to be able to play songs out loud, and you could use this code in your own projects, like a web
game. After compiling the synth code, open website/synth_example.html to see a demo using it. To rebuild just the synth code, run:

```
npm run build-synth
```

The [editor/](editor) folder has additional code to display the online song
editor interface. After compiling the editor code, open website/index.html to
see the editor interface. To rebuild just the editor code, run:

```
npm run build-editor
```

The duet feature lives in these editor files:

- [DuetSession.ts](editor/DuetSession.ts): keeps the song in sync between everyone in a room.
- [DuetMerge.ts](editor/DuetMerge.ts): combines edits that two people made to the same song at the same time.
- [DuetNetwork.ts](editor/DuetNetwork.ts): room codes, invite links, and the Trystero connection.
- [DuetPrompt.ts](editor/DuetPrompt.ts): the Duet window.
- [DuetPointers.ts](editor/DuetPointers.ts): draws other people's mouse pointers.

The [player/](player) folder has a miniature song player interface for embedding
on other sites. To rebuild just the player code, run:

```
npm run build-player
```

The [website/](website) folder contains index.html files to view the interfaces.
The build process outputs JavaScript files into this folder.

## Dependencies

Most of the dependencies are listed in [package.json](package.json), although
UltraBox, and so DuetBox, also has an indirect, optional dependency on
[lamejs](https://www.npmjs.com/package/lamejs) via
[jsdelivr](https://www.jsdelivr.com/) for exporting .mp3 files. If the user
attempts to export an .mp3 file, the editor will direct the browser to download
that dependency on demand.

## Offline version

If you'd like to build the offline version, enter the following into the command line of your choice:
```
npm run build-offline
```

After building, you can then enter the following to run it for testing purposes:
```
npm run start
```

And to package, run (do ```npm run package-host``` for your host platform; you may need to run git bash as an administrator for non-host platforms):
```
npm run package
```

## Credits

DuetBox is built on [UltraBox](https://github.com/ultraabox/ultrabox_typescript), first envisioned by Neptendo and made possible by its contributors,
which builds on [JummBox](https://github.com/jummbus/jummbox) and [BeepBox](https://beepbox.co) by [John Nesky](http://www.johnnesky.com/).
If you ever feel so inclined, please support the original creator of BeepBox via
[PayPal](https://www.paypal.com/cgi-bin/webscr?cmd=_donations&business=QZJTX9GRYEV9N&currency_code=USD)!

Networking is powered by [Trystero](https://github.com/dmotz/trystero) by Dan Motzenbecker. All of these projects, and DuetBox, are available under the MIT license.
