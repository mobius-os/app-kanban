# Isolated visual fixture

sharing.fixture.jsx replaces bridge operations and fetch with fixture state.
Compile in a disposable copy with ShareSheet exported from ui/Board.jsx. Load
only in an authenticated test frame with all live storage calls blocked before
any fixture runs. Never apply this fixture as a real app or use production data.
Verify Finish sharing, Create invite link and Copy; then close the browser.

recovery.fixture.jsx mounts the Board with a synthetic viewer and rejected edit.
It replaces fetch/storage and intercepts anchor download without sending data.
Compile in a disposable copy. Verify **Download recovery copy** includes the
original operation and that starting the download dismisses only the exported
rejected-edit reminder. Never apply as a real app.
