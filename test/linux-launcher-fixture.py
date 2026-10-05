import os, sys, tempfile, subprocess, pty, select, time
from pathlib import Path
root = Path(__file__).resolve().parent.parent

def start(args, cwd, env=None):
    master, slave = pty.openpty()
    proc = subprocess.Popen(['/bin/bash', str(root/'scripts/start-shared-camera.sh'), *args], stdin=slave, stdout=slave, stderr=slave, cwd=cwd, env=env)
    os.close(slave)
    return proc, master

def read_until(proc, fd, needle, timeout=3):
    data = b''
    end = time.monotonic()+timeout
    while time.monotonic()<end:
        if select.select([fd],[],[],0.05)[0]:
            try: chunk = os.read(fd,65536)
            except OSError: break
            data += chunk
            if needle in data: return data
        if proc.poll() is not None: break
    return data

with tempfile.TemporaryDirectory(prefix='camera launcher ') as tmp:
    tmp = Path(tmp)
    marker = tmp/'child'
    fake = tmp/'fake node'
    fake.write_text('#!/bin/bash\n: > '+"'"+str(marker)+"'"+'\n')
    fake.chmod(0o700)
    args = ['--node', str(fake)]
    if sys.argv[1]=='terminal':
        for duration_args in [[], ['--minutes', '1440']]:
            result = subprocess.run(['bash', str(root/'scripts/start-shared-camera.sh'), *args, *duration_args], capture_output=True, text=True)
            assert result.returncode != 0
            assert 'terminal' in result.stderr.lower(), result.stderr
            assert not marker.exists()
    elif sys.argv[1]=='interactive-day':
        fake.write_text('#!/bin/bash\nprintf "CHILD:%s\\n" "$@"\n')
        proc, fd = start(args,tmp)
        try:
            output = read_until(proc,fd,b'Session duration in minutes')
            assert b'Session duration in minutes' in output, output
            assert b'1440 minutes = 24 hours (one full day)' in output, output
            assert b'CHILD:' not in output, output
            os.write(fd,b'1440\n')
            output += read_until(proc,fd,b'Type START')
            assert b'Start shared camera for 1440 minutes. Type START' in output, output
            assert b'CHILD:' not in output, output
            os.write(fd,b'START\n')
            output += read_until(proc,fd,b'CHILD:1440')
            assert proc.wait(timeout=3)==0, output
            assert b'CHILD:--minutes\r\nCHILD:1440' in output, output
        finally:
            if proc.poll() is None: proc.kill(); proc.wait()
            os.close(fd)
    elif sys.argv[1]=='interactive-validation':
        # Only this owned synthetic executable can run; never load a camera runtime.
        fake.write_text('#!/bin/bash\nprintf "CHILD:%s\\n" "$@"\n')
        cases = [(b'\n', b'START\n', 30), (b'1\n', b'START\n', 1),
                 (b'10080\n', b'START\n', 10080), (b'00008\n', b'START\n', 8)]
        cases += [(value, None, None) for value in
                  [b'0\n', b'10081\n', b'1.5\n', b'NaN\n', b'-1\n',
                   b'1e2\n', b' \n', b' 30\n', b'30 \n', b'999999999999999999999999\n',
                   b'START\n', b'\x04']]
        cases += [(b'1440\n', answer, None) for answer in
                  [b'\n', b'yes\n', b'start\n', b'START \n', b'\x04']]
        for duration, answer, expected in cases:
            proc, fd = start(args,tmp)
            try:
                output = read_until(proc,fd,b'blank = 30): ')
                assert b'Session duration in minutes' in output, output
                assert b'blank = 30' in output, output
                os.write(fd,duration)
                if answer is not None:
                    output += read_until(proc,fd,b'Type START')
                    assert b'Type START' in output, output
                    assert b'CHILD:' not in output, output
                    os.write(fd,answer)
                output += read_until(proc,fd,b'\x00')
                status = proc.wait(timeout=3)
                if expected is None:
                    assert status != 0 and b'CHILD:' not in output, output
                    if answer is None: assert b'Type START' not in output, output
                else:
                    assert status == 0, output
                    assert ('CHILD:--minutes\r\nCHILD:'+str(expected)).encode() in output, output
            finally:
                if proc.poll() is None: proc.kill(); proc.wait()
                os.close(fd)
    elif sys.argv[1]=='explicit-duration':
        fake.write_text('#!/bin/bash\nprintf "CHILD:%s\\n" "$@"\n')
        for value in ['1', '30', '1440', '10080', '00008']:
            proc, fd = start([*args,'--minutes',value],tmp)
            try:
                output = read_until(proc,fd,b'Type START')
                assert b'Type START' in output, output
                assert b'Session duration' not in output and b'one full day' not in output, output
                assert b'CHILD:' not in output, output
                os.write(fd,b'START\n')
                output += read_until(proc,fd,b'\x00')
                assert proc.wait(timeout=3)==0, output
                assert ('CHILD:--minutes\r\nCHILD:'+str(int(value))).encode() in output, output
            finally:
                if proc.poll() is None: proc.kill(); proc.wait()
                os.close(fd)
    elif sys.argv[1]=='duration':
        for value in ['0','10081','1.5','NaN','-1','1e2','', '999999999999999999999999']:
            proc, fd = start([*args,'--minutes',value],tmp)
            output = read_until(proc,fd,b'minutes')
            assert proc.wait(timeout=3)!=0, output
            os.close(fd)
            assert b'minutes' in output, output
            assert not marker.exists()
    elif sys.argv[1]=='confirmation':
        fake.write_text('#!/bin/bash\nprintf "CHILD:%s\\n" "$@"\n')
        for answer in [b'yes\n', b'\n', b'START\n']:
            proc, fd = start([*args, '--config', 'config file.json', '--vendor-root', 'vendor path'],tmp)
            output = read_until(proc,fd,b'blank = 30): ')
            assert b'Session duration in minutes' in output, output
            os.write(fd,b'\n')
            output = read_until(proc,fd,b'Type START')
            assert b'Type START' in output, output
            os.write(fd,answer)
            output += read_until(proc,fd,b'CHILD:30')
            status = proc.wait(timeout=3)
            if answer==b'START\n':
                assert status==0, output
                assert str(tmp/'config file.json').encode() in output, output
                assert str(tmp/'vendor path').encode() in output, output
                assert b'CHILD:30' in output, output
            else:
                assert status!=0, output
                assert b'CHILD:' not in output, output
            os.close(fd)
    elif sys.argv[1]=='duplicate':
        fake.write_text('#!/usr/bin/env python3\nimport os,signal,time\nprint("OWNER:"+str(os.getpid()),flush=True)\nsignal.signal(signal.SIGINT, lambda *_: exit(0))\ntime.sleep(15)\n')
        owner, owner_fd = start([*args,'--minutes','30'],tmp)
        try:
            output = read_until(owner,owner_fd,b'Type START')
            assert b'Type START' in output, output
            os.write(owner_fd,b'START\n')
            output = read_until(owner,owner_fd,b'OWNER:')
            assert b'OWNER:' in output, output
            assert ('OWNER:'+str(owner.pid)).encode() in output, output
            contender, fd = start([*args,'--config','other config','--minutes','30'],tmp)
            try:
                output = read_until(contender,fd,b'Type START')
                if b'Type START' in output: os.write(fd,b'START\n')
                output += read_until(contender,fd,b'already')
                assert contender.wait(timeout=3)!=0, output
                assert b'already' in output, output
                assert b'OWNER:' not in output, output
                assert owner.poll() is None
            finally:
                if contender.poll() is None: contender.kill(); contender.wait()
                os.close(fd)
            owner.send_signal(2)
            assert owner.wait(timeout=3)==0
        finally:
            if owner.poll() is None: owner.kill(); owner.wait()
            os.close(owner_fd)
    elif sys.argv[1]=='explicit-node':
        bindir = tmp/'bin'; bindir.mkdir()
        for command in ['dirname','stat','flock','mkdir']:
            import shutil
            (bindir/command).symlink_to(shutil.which(command))
        fake.write_text('#!/bin/bash\nprintf "CHILD\\n"\n')
        proc, fd = start(args,tmp,{**os.environ,'PATH':str(bindir)})
        try:
            output = read_until(proc,fd,b'blank = 30): ')
            assert b'Session duration in minutes' in output, output
            os.write(fd,b'\n')
            output = read_until(proc,fd,b'Type START')
            assert b'Type START' in output, output
            os.write(fd,b'START\n')
            output += read_until(proc,fd,b'CHILD')
            assert proc.wait(timeout=3)==0, output
            assert b'CHILD' in output, output
        finally:
            if proc.poll() is None: proc.kill(); proc.wait()
            os.close(fd)
