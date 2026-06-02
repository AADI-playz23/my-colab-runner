import os
import time
import json
import threading
import subprocess
import select
import asyncio
import websockets
import re
import sys
import shutil
from urllib import request, parse

try:
    import pty
    HAS_PTY = True
except ImportError:
    HAS_PTY = False
import websockets
import re
import shutil
from urllib import request, parse

BASE_URL = os.environ.get("BASE_URL", "https://absoradevbox.vercel.app")
API_URL = BASE_URL + "/api/worker_api"
BAN_API_URL = BASE_URL + "/api/ban_user"
RUNNER_ID = os.environ.get("RUNNER_ID", "local_runner")
PORT = 8080
MAX_SLOTS = 20

active_sessions = {}
worker_url = None
registered_vm_id = None

def api_call(op, payload=None, url=None):
    try:
        if payload is None:
            payload = {}
        payload['op'] = op
        data = json.dumps(payload).encode('utf-8')
        target_url = url or API_URL
        req = request.Request(target_url, data=data, headers={'Content-Type': 'application/json'})
        with request.urlopen(req, timeout=10) as response:
            return json.loads(response.read().decode('utf-8'))
    except Exception as e:
        print(f"API Error ({op}): {e}")
        return {"status": "error"}

def heartbeat_loop():
    global registered_vm_id
    print("Started heartbeat loop")
    
    # Track when the runner had 0 users
    zero_users_start_time = time.time()
    
    while True:
        num_users = len(active_sessions)
        
        # Idle termination logic
        if num_users == 0:
            if time.time() - zero_users_start_time > 120:
                print("No active users for 2 minutes. Terminating runner to save resources.")
                os._exit(0)
        else:
            zero_users_start_time = time.time()
            
        try:
            result = api_call("vm_heartbeat", {
                "vm_id": registered_vm_id or RUNNER_ID,
                "active_users": num_users
            })
            # If VM was not found in DB, re-register
            if result.get("status") == "error" and worker_url:
                print("VM not found in DB, re-registering...")
                reg_result = api_call("register_vm", {
                    "vm_id": RUNNER_ID,
                    "worker_url": worker_url
                })
                if reg_result.get("status") == "success":
                    registered_vm_id = reg_result.get("vm_id", RUNNER_ID)
                    print(f"Re-registered as VM: {registered_vm_id}")
        except:
            pass
        time.sleep(30)

def start_tunnel():
    global worker_url, registered_vm_id
    print("Starting cloudflared tunnel...")
    tunnel_proc = subprocess.Popen(
        ["cloudflared", "tunnel", "--url", f"http://localhost:{PORT}"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True
    )
    for line in tunnel_proc.stdout:
        print(f"[TUNNEL] {line.strip()}")
        match = re.search(r'https://[a-zA-Z0-9-]+\.trycloudflare\.com', line)
        if match:
            url = match.group(0)
            worker_url = url.replace("https://", "wss://")
            print(f"Tunnel established: {worker_url}")
            
            # Register VM with the Backend
            reg_result = api_call("register_vm", {
                "vm_id": RUNNER_ID,
                "worker_url": worker_url
            })
            registered_vm_id = reg_result.get("vm_id", RUNNER_ID)
            print(f"Registered as VM: {registered_vm_id}")
            
            # Start Heartbeat thread
            threading.Thread(target=heartbeat_loop, daemon=True).start()
            break

def get_dir_size(path):
    total = 0
    try:
        for dirpath, _, filenames in os.walk(path):
            for f in filenames:
                fp = os.path.join(dirpath, f)
                if not os.path.islink(fp):
                    total += os.path.getsize(fp)
    except:
        pass
    return total / (1024 * 1024)

async def handle_client(websocket):
    print("Client connected!")
    session_id = None
    
    try:
        auth_msg = await websocket.recv()
        auth_data = json.loads(auth_msg)
        if auth_data.get('type') != 'auth':
            await websocket.send(json.dumps({"type": "error", "message": "Invalid auth"}))
            return
            
        session_id = auth_data['session_id']
        plan = auth_data.get('plan', 'free')
        timeout_secs = int(auth_data.get('timeout', 1800))
        
        # Inactivity tracking
        last_activity = time.time()
        
        # Enforce Max Slots
        if len(active_sessions) >= MAX_SLOTS and session_id not in active_sessions:
            await websocket.send(json.dumps({"type": "error", "message": "VM Full"}))
            return
            
        active_sessions[session_id] = {
            "ws": websocket,
            "last_activity": last_activity
        }
        
        print(f"Auth successful for {session_id}")
        
        if sys.platform == "win32":
            home_dir = os.path.abspath(f"./home/devbox_{session_id[:8]}")
            os.makedirs(home_dir, exist_ok=True)
        else:
            home_dir = f"/home/devbox_{session_id[:8]}"
            try:
                os.makedirs(home_dir, exist_ok=True)
            except PermissionError:
                try:
                    subprocess.run(["sudo", "mkdir", "-p", home_dir], check=True)
                    subprocess.run(["sudo", "chown", f"{os.getuid()}:{os.getgid()}", home_dir], check=True)
                except Exception:
                    home_dir = os.path.abspath(f"./home/devbox_{session_id[:8]}")
                    os.makedirs(home_dir, exist_ok=True)
        
        nice_val = 15
        ram_bytes = 4 * 1024 * 1024 * 1024
        disk_limit_mb = 500
        
        if plan == "pro":
            nice_val = 5
            ram_bytes = 8 * 1024 * 1024 * 1024
            disk_limit_mb = 1024
        elif plan == "developer":
            nice_val = 0
            ram_bytes = 16 * 1024 * 1024 * 1024
            disk_limit_mb = 3072
            
        if HAS_PTY:
            master_fd, slave_fd = pty.openpty()
        else:
            master_fd, slave_fd = None, subprocess.PIPE
            
        env = os.environ.copy()
        env["HOME"] = home_dir
        env["USER"] = f"devbox_{session_id[:8]}"
        
        import time
        
        def start_process(cmd_list):
            for cmd in cmd_list:
                try:
                    if HAS_PTY:
                        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=slave_fd, stderr=slave_fd, cwd=home_dir, env=env, text=True, bufsize=1)
                    else:
                        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, cwd=home_dir, env=env, text=True, bufsize=1)
                    
                    # Wait slightly to see if process crashes immediately (e.g. prlimit failed)
                    time.sleep(0.1)
                    if proc.poll() is None:
                        return proc
                except FileNotFoundError:
                    pass
            return None

        # On Windows, fallback to simple bash or cmd
        if sys.platform == "win32":
            cmds_to_try = [["cmd.exe"]]
        else:
            cmds_to_try = [
                ["prlimit", f"--as={ram_bytes}", "nice", f"-n{nice_val}", "/bin/bash"],
                ["nice", f"-n{nice_val}", "/bin/bash"],
                ["/bin/bash"]
            ]
            
        p = start_process(cmds_to_try)
        if not p:
            raise Exception("Failed to start bash process. All command fallbacks failed.")
            
        if HAS_PTY:
            os.close(slave_fd)

        async def resource_monitor():
            while p.poll() is None:
                size_mb = get_dir_size(home_dir)
                if size_mb > disk_limit_mb:
                    try:
                        await websocket.send(json.dumps({"type": "message", "data": f"\n\n[SYSTEM] Disk Quota Exceeded ({disk_limit_mb}MB). Terminating process.\n"}))
                        p.terminate()
                    except:
                        pass
                    break
                
                # Check Inactivity (3 minutes = 180 seconds)
                if time.time() - active_sessions.get(session_id, {}).get("last_activity", time.time()) > 180:
                    try:
                        await websocket.send(json.dumps({"type": "message", "data": f"\n\n[SYSTEM] Session terminated due to 3 minutes of inactivity.\n"}))
                        p.terminate()
                    except:
                        pass
                    break
                    
                # Send Usage Update
                try:
                    await websocket.send(json.dumps({
                        "type": "usage",
                        "disk_mb": round(size_mb, 2),
                        "disk_max_mb": disk_limit_mb
                    }))
                except:
                    pass
                    
                await asyncio.sleep(5)
                
        asyncio.create_task(resource_monitor())
        
        async def read_bash_output():
            try:
                while p.poll() is None:
                    if HAS_PTY:
                        # On Unix with PTY
                        rlist, _, _ = select.select([master_fd], [], [], 0.1)
                        if rlist:
                            chunk = os.read(master_fd, 4096).decode('utf-8', errors='replace')
                            if chunk:
                                await websocket.send(json.dumps({"type": "message", "data": chunk}))
                    else:
                        # On Windows without PTY, just read line by line non-blocking if possible,
                        # but Popen.stdout.readline() is blocking. We'll use a simple approach for testing:
                        line = p.stdout.readline()
                        if line:
                            await websocket.send(json.dumps({"type": "message", "data": line}))
                        else:
                            break
                    await asyncio.sleep(0.01)
            except Exception as e:
                pass
                
        asyncio.create_task(read_bash_output())
        
        async for message in websocket:
            active_sessions[session_id]["last_activity"] = time.time()
            data = json.loads(message)
            msg_type = data.get('type')
            
            if msg_type == 'command':
                cell_id = data.get('cell_id', '')
                raw_cmd = data.get('command', '')
                
                # Security Engine - Exploit Detection
                # A simple blacklist for common exploit attempts in free VMs
                blacklist = ['nmap ', 'masscan ', 'xmrig', 'cgminer', 'ethminer', 'stratum+tcp', ':(){ :|:& };:']
                
                is_exploit = False
                for term in blacklist:
                    if term in raw_cmd:
                        is_exploit = True
                        break
                        
                if is_exploit:
                    print(f"EXPLOIT DETECTED in session {session_id}! Command: {raw_cmd}")
                    try:
                        await websocket.send(json.dumps({"type": "message", "data": "\n\n[SECURITY] EXPLOIT DETECTED. SESSION TERMINATED. ACCOUNT BANNED.\n"}))
                    except: pass
                    
                    # 1. Terminate process immediately
                    try: p.terminate()
                    except: pass
                    
                    # 2. Zip the home directory for forensics
                    zip_path = f"/tmp/exploit_{session_id}.zip"
                    shutil.make_archive(zip_path.replace('.zip', ''), 'zip', home_dir)
                    
                    # 3. Upload to file.io (ephemeral 1-time download link for Admin)
                    try:
                        with open(zip_path, 'rb') as f:
                            req = request.Request("https://file.io", data=f.read())
                            with request.urlopen(req, timeout=15) as response:
                                res_data = json.loads(response.read().decode('utf-8'))
                                link = res_data.get('link', 'Upload failed')
                                print(f"Forensics uploaded: {link}")
                    except Exception as e:
                        print(f"Failed to upload forensics: {e}")
                        
                    # 4. Ban User via API
                    api_call("ban_user", {
                        "vm_id": RUNNER_ID,
                        "session_id": session_id
                    }, url=BAN_API_URL)
                    
                    break # Break out of websocket loop to disconnect
                
                magic = f"__DEVBOX_EOF_{cell_id}__"
                cmd_str = raw_cmd + f"\necho '{magic}'\n"
                
                try:
                    p.stdin.write(cmd_str)
                    p.stdin.flush()
                except BrokenPipeError:
                    err_msg = f"\n\n[SYSTEM ERROR] Process died unexpectedly (Exit code: {p.poll()}). Please restart session.\n"
                    try:
                        await websocket.send(json.dumps({"type": "message", "data": err_msg}))
                    except: pass
                
            elif msg_type == 'list_dir':
                path = data.get('path', '/')
                full_path = os.path.abspath(os.path.join(home_dir, path.lstrip('/')))
                if not full_path.startswith(home_dir):
                    await websocket.send(json.dumps({"type": "file_error", "message": "Access denied"}))
                    continue
                try:
                    items = []
                    if os.path.exists(full_path):
                        for f in os.listdir(full_path):
                            f_path = os.path.join(full_path, f)
                            items.append({"name": f, "is_dir": os.path.isdir(f_path)})
                    await websocket.send(json.dumps({"type": "dir_list", "path": path, "items": items}))
                except Exception as e:
                    await websocket.send(json.dumps({"type": "file_error", "message": str(e)}))
                    
            elif msg_type == 'read_file':
                path = data.get('path', '')
                full_path = os.path.abspath(os.path.join(home_dir, path.lstrip('/')))
                if not full_path.startswith(home_dir) or not os.path.isfile(full_path):
                    continue
                try:
                    with open(full_path, 'r', encoding='utf-8') as f:
                        content = f.read()
                    await websocket.send(json.dumps({"type": "file_content", "path": path, "content": content}))
                except Exception as e:
                    await websocket.send(json.dumps({"type": "file_error", "message": str(e)}))
                    
            elif msg_type == 'write_file':
                path = data.get('path', '')
                content = data.get('content', '')
                full_path = os.path.abspath(os.path.join(home_dir, path.lstrip('/')))
                if not full_path.startswith(home_dir):
                    continue
                try:
                    with open(full_path, 'w', encoding='utf-8') as f:
                        f.write(content)
                    await websocket.send(json.dumps({"type": "file_saved", "path": path}))
                except Exception as e:
                    await websocket.send(json.dumps({"type": "file_error", "message": str(e)}))
                    
            elif msg_type == 'create_folder':
                path = data.get('path', '')
                full_path = os.path.abspath(os.path.join(home_dir, path.lstrip('/')))
                if full_path.startswith(home_dir):
                    os.makedirs(full_path, exist_ok=True)
                    
            elif msg_type == 'delete_item':
                path = data.get('path', '')
                full_path = os.path.abspath(os.path.join(home_dir, path.lstrip('/')))
                if full_path.startswith(home_dir):
                    if os.path.isdir(full_path):
                        shutil.rmtree(full_path, ignore_errors=True)
                    else:
                        try:
                            os.remove(full_path)
                        except:
                            pass
                            
    except websockets.exceptions.ConnectionClosed:
        print(f"Client {session_id} disconnected")
    except Exception as e:
        import traceback
        err_msg = traceback.format_exc()
        print(f"Handler error: {err_msg}")
        try:
            await websocket.send(json.dumps({"type": "message", "data": f"\n\n[RUNNER ERROR]: {str(e)}\n{err_msg}\n"}))
        except:
            pass
    finally:
        if session_id and session_id in active_sessions:
            del active_sessions[session_id]
            try:
                p.terminate()
                if HAS_PTY:
                    os.close(master_fd)
            except:
                pass

async def main_loop():
    # We let websockets handle invalid HTTP requests normally. 
    # It will log 'InvalidUpgrade' but keep running perfectly fine.
    server = await websockets.serve(handle_client, "0.0.0.0", PORT)
    print(f"WebSocket server started on port {PORT}")
    await asyncio.Future()

def main():
    print("DevBox Multi-Tenant Runner Started")
    threading.Thread(target=start_tunnel, daemon=True).start()
    asyncio.run(main_loop())

if __name__ == "__main__":
    main()
