import os
import time
import json
import threading
import subprocess
import select
import pty
import asyncio
import websockets
import re
import shutil
from urllib import request, parse
import redis

REDIS_HOST = os.environ.get("REDIS_HOST", "blooming-glove-existence-12929.db.redis.io")
REDIS_PORT = int(os.environ.get("REDIS_PORT", "11619"))
REDIS_PASS = os.environ.get("REDIS_PASS", "RzhVwv9LrOuQI9wNpO2IdRKVynCVQO6Z")

PORT = 8080
MAX_SLOTS = 20

active_sessions = {}
worker_url = None

redis_client = None
try:
    redis_client = redis.Redis(host=REDIS_HOST, port=REDIS_PORT, password=REDIS_PASS, decode_responses=True)
except Exception as e:
    print(f"Redis connection failed: {e}")

def start_tunnel():
    global worker_url
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
            break

async def job_poller():
    global worker_url
    while worker_url is None:
        await asyncio.sleep(1)
        
    print("Starting Redis job poller...")
    while True:
        try:
            current_time = time.time()
            to_remove = []
            for sid, sdata in active_sessions.items():
                if current_time - sdata["start_time"] > sdata["timeout_secs"]:
                    print(f"Session {sid} timed out.")
                    to_remove.append(sid)
            for sid in to_remove:
                close_session(sid)
            
            if len(active_sessions) < MAX_SLOTS and redis_client:
                job_json = redis_client.lpop("devbox_queue")
                if job_json:
                    job = json.loads(job_json)
                    session_id = job.get('session_id')
                    plan = job.get('plan', 'free')
                    timeout_secs = int(job.get('timeout_secs', 1800))
                    
                    print(f"Claimed job {session_id} (Plan: {plan})")
                    
                    active_sessions[session_id] = {
                        "plan": plan,
                        "timeout_secs": timeout_secs,
                        "start_time": time.time(),
                        "proc": None,
                        "master_fd": None,
                        "ws": None
                    }
                    
                    # Announce URL
                    redis_client.setex(f"devbox_url:{session_id}", timeout_secs, worker_url)
        except Exception as e:
            print(f"Poller error: {e}")
        
        await asyncio.sleep(2)

def close_session(session_id):
    if session_id in active_sessions:
        sdata = active_sessions[session_id]
        if sdata.get("proc"):
            sdata["proc"].terminate()
        if sdata.get("master_fd"):
            os.close(sdata["master_fd"])
        del active_sessions[session_id]
        if redis_client:
            redis_client.delete(f"devbox_url:{session_id}")

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
        if auth_data.get('type') != 'auth' or auth_data.get('session_id') not in active_sessions:
            await websocket.send(json.dumps({"type": "error", "message": "Invalid auth"}))
            return
            
        session_id = auth_data['session_id']
        sdata = active_sessions[session_id]
        sdata["ws"] = websocket
        
        print(f"Auth successful for {session_id}")
        
        home_dir = f"/home/devbox_{session_id[:8]}"
        os.makedirs(home_dir, exist_ok=True)
        
        nice_val = 15
        ram_bytes = 4 * 1024 * 1024 * 1024
        disk_limit_mb = 500
        
        if sdata["plan"] == "pro":
            nice_val = 5
            ram_bytes = 8 * 1024 * 1024 * 1024
            disk_limit_mb = 1024
        elif sdata["plan"] == "developer":
            nice_val = 0
            ram_bytes = 16 * 1024 * 1024 * 1024
            disk_limit_mb = 3072
            
        master_fd, slave_fd = pty.openpty()
        env = os.environ.copy()
        env["HOME"] = home_dir
        env["USER"] = f"devbox_{session_id[:8]}"
        
        cmd = ["prlimit", f"--as={ram_bytes}", "nice", f"-n{nice_val}", "/bin/bash"]
        try:
            p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=slave_fd, stderr=slave_fd, cwd=home_dir, env=env, text=True, bufsize=1)
        except FileNotFoundError:
            p = subprocess.Popen(["nice", f"-n{nice_val}", "/bin/bash"], stdin=subprocess.PIPE, stdout=slave_fd, stderr=slave_fd, cwd=home_dir, env=env, text=True, bufsize=1)
            
        os.close(slave_fd)
        sdata["proc"] = p
        sdata["master_fd"] = master_fd

        async def disk_monitor():
            while p.poll() is None:
                size_mb = get_dir_size(home_dir)
                if size_mb > disk_limit_mb:
                    try:
                        await websocket.send(json.dumps({"type": "message", "data": f"\n\n[SYSTEM] Disk Quota Exceeded ({disk_limit_mb}MB). Terminating process.\n"}))
                        p.terminate()
                    except:
                        pass
                    break
                await asyncio.sleep(10)
                
        asyncio.create_task(disk_monitor())
        
        async def read_bash_output():
            try:
                while p.poll() is None:
                    rlist, _, _ = select.select([master_fd], [], [], 0.1)
                    if rlist:
                        chunk = os.read(master_fd, 4096).decode('utf-8', errors='replace')
                        if chunk:
                            await websocket.send(json.dumps({"type": "message", "data": chunk}))
                    await asyncio.sleep(0.01)
            except Exception as e:
                pass
                
        reader_task = asyncio.create_task(read_bash_output())
        
        async for message in websocket:
            data = json.loads(message)
            msg_type = data.get('type')
            
            if msg_type == 'command':
                cell_id = data.get('cell_id', '')
                magic = f"__DEVBOX_EOF_{cell_id}__"
                cmd_str = data.get('command', '') + f"\necho '{magic}'\n"
                p.stdin.write(cmd_str)
                p.stdin.flush()
                
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
        print(f"Handler error: {e}")
    finally:
        if session_id and session_id in active_sessions:
            active_sessions[session_id]["ws"] = None

async def main_loop():
    server = await websockets.serve(handle_client, "0.0.0.0", PORT)
    print(f"WebSocket server started on port {PORT}")
    asyncio.create_task(job_poller())
    await asyncio.Future()

def main():
    print("DevBox Multi-Tenant Runner Started")
    threading.Thread(target=start_tunnel, daemon=True).start()
    asyncio.run(main_loop())

if __name__ == "__main__":
    main()
