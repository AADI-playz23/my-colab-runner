import os
import time
import json
import redis
import threading
import subprocess
import select
import pty
from datetime import datetime

REDIS_HOST = os.environ.get("REDIS_HOST", "localhost")
REDIS_PORT = int(os.environ.get("REDIS_PORT", 6379))
REDIS_PASS = os.environ.get("REDIS_PASS", "")

r = redis.Redis(host=REDIS_HOST, port=REDIS_PORT, password=REDIS_PASS, decode_responses=True)

MAX_SLOTS = 10
active_sessions = {}
lock = threading.Lock()

def bash_worker(session_id):
    # Fetch session info
    status = r.hget(f"devbox:session:{session_id}", "status")
    username = r.hget(f"devbox:session:{session_id}", "username")
    timeout_secs = int(r.hget(f"devbox:session:{session_id}", "timeout_secs") or 1800)
    
    r.hset(f"devbox:session:{session_id}", "status", "active")
    r.hset(f"devbox:session:{session_id}", "started_at", int(time.time()))
    
    home_dir = f"/home/{username}"
    os.makedirs(home_dir, exist_ok=True)
    
    master_fd, slave_fd = pty.openpty()
    
    env = os.environ.copy()
    env["HOME"] = home_dir
    env["USER"] = username
    
    p = subprocess.Popen(
        ["/bin/bash"],
        stdin=subprocess.PIPE,
        stdout=slave_fd,
        stderr=slave_fd,
        cwd=home_dir,
        env=env,
        text=True,
        bufsize=1
    )
    
    os.close(slave_fd)
    
    queue_name = f"devbox:session:{session_id}:queue"
    start_time = time.time()
    
    try:
        while True:
            # Check session timeout
            if time.time() - start_time > timeout_secs:
                break
                
            # Pop cell command with 1s timeout
            item = r.blpop(queue_name, timeout=1)
            if not item:
                # No command, keep alive
                continue
                
            # We got a command
            payload = json.loads(item[1])
            cell_id = payload['cell_id']
            code = payload['code']
            
            output_chan = f"devbox:output:{session_id}:{cell_id}"
            
            # Magic string to detect end of command
            magic = f"__DEVBOX_EOF_{cell_id}__"
            
            # Send code and magic echo to bash
            full_cmd = f"{code}\necho '{magic}'\n"
            p.stdin.write(full_cmd)
            p.stdin.flush()
            
            # Read output until magic string
            buffer = ""
            while True:
                rlist, _, _ = select.select([master_fd], [], [], 0.1)
                if rlist:
                    chunk = os.read(master_fd, 1024).decode('utf-8', errors='replace')
                    if not chunk:
                        break
                    
                    buffer += chunk
                    
                    # Split by newline and publish
                    lines = buffer.split('\n')
                    # Keep the last incomplete line in buffer
                    buffer = lines.pop()
                    
                    for line in lines:
                        clean_line = line.replace('\r', '')
                        if magic in clean_line:
                            break # cell done
                        
                        r.publish(output_chan, clean_line)
                    
                    if magic in buffer:
                        break
                        
            # Publish EOF to let client know cell finished
            r.publish(output_chan, "[[EOF]]")
            
    except Exception as e:
        print(f"Error in session {session_id}: {e}")
    finally:
        p.terminate()
        os.close(master_fd)
        r.hset(f"devbox:session:{session_id}", "status", "expired")
        with lock:
            if session_id in active_sessions:
                del active_sessions[session_id]


def main():
    print("DevBox Runner Started")
    runner_id = os.environ.get("RUNNER_ID", "1")
    alive_key = f"devbox:runner:{runner_id}:alive"
    
    start_time = time.time()
    MAX_LIFETIME = 5.5 * 3600 # 5.5 hours to be safe within GitHub 6h limit
    
    while time.time() - start_time < MAX_LIFETIME:
        r.setex(alive_key, 60, "1")
        
        with lock:
            current_slots = len(active_sessions)
            
        r.set(f"devbox:runner:{runner_id}:slots_used", current_slots)
        
        if current_slots < MAX_SLOTS:
            # Try priority queue first
            item = r.lpop("devbox:queue:priority")
            if not item:
                item = r.lpop("devbox:queue:normal")
                
            if item:
                session_id = item
                with lock:
                    active_sessions[session_id] = True
                
                t = threading.Thread(target=bash_worker, args=(session_id,), daemon=True)
                t.start()
            else:
                time.sleep(2) # no jobs
        else:
            time.sleep(5) # full slots

if __name__ == "__main__":
    main()
