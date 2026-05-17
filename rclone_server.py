from mcp.server.fastmcp import FastMCP
import asyncio
import json

mcp = FastMCP("rclone-gdrive")
RCLONE = r"C:\tools\rclone.exe"
REMOTE = "gdrive:"


async def _run(*args) -> dict | list | str:
    proc = await asyncio.create_subprocess_exec(
        RCLONE, *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    if proc.returncode != 0:
        return {"error": stderr.decode().strip(), "returncode": proc.returncode}
    return stdout.decode().strip()


# ── Browse ─────────────────────────────────────────────────────────────────────

@mcp.tool()
async def rclone_list(path: str = "") -> list | dict:
    """List files and folders in Google Drive. path is relative to root (e.g. 'Projects/2025')."""
    result = await _run("lsjson", f"{REMOTE}{path}")
    if isinstance(result, dict):
        return result
    return json.loads(result) if result else []


@mcp.tool()
async def rclone_stat(remote_path: str) -> dict:
    """Get metadata (name, size, modified date) of a file or folder in Google Drive."""
    result = await _run("lsjson", "--stat", f"{REMOTE}{remote_path}")
    if isinstance(result, dict):
        return result
    data = json.loads(result)
    return data[0] if data else {"error": "not found"}


@mcp.tool()
async def rclone_search(query: str, path: str = "") -> list | dict:
    """Search for files by name pattern in Google Drive (supports wildcards, e.g. '*.pdf')."""
    result = await _run("lsjson", "--recursive", "--include", query, f"{REMOTE}{path}")
    if isinstance(result, dict):
        return result
    return json.loads(result) if result else []


# ── Upload / Download ──────────────────────────────────────────────────────────

@mcp.tool()
async def rclone_upload(local_path: str, remote_path: str) -> dict:
    """Upload a local file to Google Drive. Handles large files efficiently with resumable transfer."""
    result = await _run("copyto", local_path, f"{REMOTE}{remote_path}")
    if isinstance(result, dict):
        return result
    return {"success": True, "uploaded_to": f"{REMOTE}{remote_path}"}


@mcp.tool()
async def rclone_download(remote_path: str, local_path: str) -> dict:
    """Download a file from Google Drive to a local path. Handles large files efficiently."""
    result = await _run("copyto", f"{REMOTE}{remote_path}", local_path)
    if isinstance(result, dict):
        return result
    return {"success": True, "downloaded_to": local_path}


# ── Manage ─────────────────────────────────────────────────────────────────────

@mcp.tool()
async def rclone_mkdir(remote_path: str) -> dict:
    """Create a folder (and any missing parent folders) in Google Drive."""
    result = await _run("mkdir", f"{REMOTE}{remote_path}")
    if isinstance(result, dict):
        return result
    return {"success": True, "created": remote_path}


@mcp.tool()
async def rclone_move(source_path: str, dest_path: str) -> dict:
    """Move or rename a file within Google Drive."""
    result = await _run("moveto", f"{REMOTE}{source_path}", f"{REMOTE}{dest_path}")
    if isinstance(result, dict):
        return result
    return {"success": True, "moved_to": dest_path}


@mcp.tool()
async def rclone_copy_remote(source_path: str, dest_path: str) -> dict:
    """Copy a file within Google Drive (server-side, no bandwidth used)."""
    result = await _run("copyto", f"{REMOTE}{source_path}", f"{REMOTE}{dest_path}")
    if isinstance(result, dict):
        return result
    return {"success": True, "copied_to": dest_path}


@mcp.tool()
async def rclone_delete(remote_path: str) -> dict:
    """Delete a single file from Google Drive."""
    result = await _run("deletefile", f"{REMOTE}{remote_path}")
    if isinstance(result, dict):
        return result
    return {"success": True, "deleted": remote_path}


@mcp.tool()
async def rclone_delete_folder(remote_path: str) -> dict:
    """Delete an entire folder and its contents from Google Drive."""
    result = await _run("purge", f"{REMOTE}{remote_path}")
    if isinstance(result, dict):
        return result
    return {"success": True, "deleted_folder": remote_path}


# ── Sync ───────────────────────────────────────────────────────────────────────

@mcp.tool()
async def rclone_sync(local_path: str, remote_path: str, direction: str = "upload") -> dict:
    """Sync a folder. direction: 'upload' (local→Drive) or 'download' (Drive→local).
    WARNING: destination is made identical to source — extra files in dest are deleted."""
    if direction == "upload":
        result = await _run("sync", local_path, f"{REMOTE}{remote_path}")
    else:
        result = await _run("sync", f"{REMOTE}{remote_path}", local_path)
    if isinstance(result, dict):
        return result
    return {"success": True, "direction": direction}
