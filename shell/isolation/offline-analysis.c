/* Minimal Linux/x64 complement to the locked DSH Landlock launcher.
 * Landlock owns filesystem confinement. This process adds no-network,
 * no-fork, no-IPC/no-foreign-process access and hard per-process limits.
 * It never grants filesystem access or falls back when enforcement fails.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <signal.h>
#include <time.h>
#include <sys/wait.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#define ALLOW(n) BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,(n),0,1),BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ALLOW)
static void failure(void){fputs("ISOLATION_ENFORCEMENT_FAILED\n",stderr);_exit(125);}
static void limit(int resource,rlim_t value){struct rlimit r={value,value};if(setrlimit(resource,&r))failure();}
static volatile sig_atomic_t stopping=0;
static void stop_supervisor(int signal_number){(void)signal_number;stopping=1;}
int main(int argc,char **argv){
 if(argc<2)failure();
 struct rlimit previous;if(getrlimit(RLIMIT_NOFILE,&previous))failure();
 if(syscall(SYS_close_range,3,~0U,0)<0){rlim_t max=previous.rlim_cur;if(max==RLIM_INFINITY||max>1048576)failure();for(rlim_t fd=3;fd<max;fd++)close((int)fd);}
 limit(RLIMIT_CORE,0);limit(RLIMIT_AS,128ULL*1024*1024);limit(RLIMIT_CPU,4);limit(RLIMIT_NOFILE,32);limit(RLIMIT_FSIZE,0);
 if(clearenv())failure();
 if(setenv("PATH","/usr/bin:/bin",1)||setenv("LANG","C.UTF-8",1)||setenv("HOME",".",1)||setenv("TMPDIR",".",1)||setenv("TZ","UTC",1)||setenv("PYTHONDONTWRITEBYTECODE","1",1))failure();
 /* The trusted supervisor remains outside the guest syscall filter. It
  * enforces a wall deadline even if the harness is killed or Python sleeps.
  * The guest cannot fork, signal its supervisor, or change process groups. */
 pid_t original_parent=getppid();if(original_parent<=1)failure();
 if(signal(SIGTERM,stop_supervisor)==SIG_ERR||signal(SIGINT,stop_supervisor)==SIG_ERR||signal(SIGHUP,stop_supervisor)==SIG_ERR)failure();
 pid_t supervisor=getpid(),child=fork();if(child<0)failure();
 if(child>0){
  struct timespec start,current,pause={0,10000000};if(clock_gettime(CLOCK_MONOTONIC,&start))failure();int status;
  for(;;){pid_t result=waitpid(child,&status,WNOHANG);if(result==child)break;if(result<0&&errno!=EINTR)failure();
   if(clock_gettime(CLOCK_MONOTONIC,&current))failure();
   if(stopping||getppid()!=original_parent||(current.tv_sec-start.tv_sec)*1000000000LL+current.tv_nsec-start.tv_nsec>=5000000000LL){kill(child,SIGKILL);while(waitpid(child,&status,0)<0){if(errno!=EINTR)failure();}break;}nanosleep(&pause,NULL);
  }
  if(WIFEXITED(status)){_exit(WEXITSTATUS(status));}
  if(WIFSIGNALED(status)){kill(getpid(),WTERMSIG(status));_exit(128+WTERMSIG(status));}
  failure();
 }
 if(prctl(PR_SET_PDEATHSIG,SIGKILL)||getppid()!=supervisor)failure();
 struct sock_filter filters[]={
  BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,arch)),
  BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,AUDIT_ARCH_X86_64,1,0),
  BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_KILL_PROCESS),
  BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,nr)),
  BPF_JUMP(BPF_JMP|BPF_JGE|BPF_K,0x40000000U,0,1),
  BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_KILL_PROCESS),
  ALLOW(SYS_read),ALLOW(SYS_write),ALLOW(SYS_readv),ALLOW(SYS_writev),ALLOW(SYS_close),ALLOW(SYS_pread64),
  ALLOW(SYS_fstat),ALLOW(SYS_stat),ALLOW(SYS_lstat),ALLOW(SYS_newfstatat),ALLOW(SYS_statx),ALLOW(SYS_lseek),
  ALLOW(SYS_getdents),ALLOW(SYS_getdents64),ALLOW(SYS_readlink),ALLOW(SYS_readlinkat),ALLOW(SYS_access),ALLOW(SYS_faccessat),ALLOW(SYS_faccessat2),
  ALLOW(SYS_mmap),ALLOW(SYS_mprotect),ALLOW(SYS_munmap),ALLOW(SYS_mremap),ALLOW(SYS_brk),ALLOW(SYS_madvise),
  ALLOW(SYS_rt_sigaction),ALLOW(SYS_rt_sigprocmask),ALLOW(SYS_rt_sigreturn),ALLOW(SYS_sigaltstack),
  ALLOW(SYS_set_tid_address),ALLOW(SYS_set_robust_list),ALLOW(SYS_rseq),ALLOW(SYS_arch_prctl),ALLOW(SYS_futex),
  ALLOW(SYS_clock_gettime),ALLOW(SYS_clock_getres),ALLOW(SYS_gettimeofday),ALLOW(SYS_time),ALLOW(SYS_nanosleep),ALLOW(SYS_clock_nanosleep),ALLOW(SYS_restart_syscall),
  ALLOW(SYS_getpid),ALLOW(SYS_getppid),ALLOW(SYS_gettid),ALLOW(SYS_getuid),ALLOW(SYS_geteuid),ALLOW(SYS_getgid),ALLOW(SYS_getegid),ALLOW(SYS_getgroups),
  ALLOW(SYS_uname),ALLOW(SYS_sysinfo),ALLOW(SYS_getrandom),ALLOW(SYS_getcwd),ALLOW(SYS_getrlimit),ALLOW(SYS_getrusage),
  ALLOW(SYS_execve),ALLOW(SYS_exit),ALLOW(SYS_exit_group),
  /* CPython checks descriptor flags; ownership/signalling fcntl operations
   * remain unavailable. */
  BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,SYS_fcntl,0,6),
  BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,args[1])),
  BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,1,3,0),
  BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,2,2,0),
  BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,3,1,0),
  BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),
  BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ALLOW),
  /* Opening is read-only even before Landlock's path decision. */
  BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,SYS_open,0,4),
  BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,args[1])),
  BPF_JUMP(BPF_JMP|BPF_JSET|BPF_K,3|0100|01000|02000|020000000,1,0),
  BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ALLOW),
  BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),
  BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,SYS_openat,0,4),
  BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,args[2])),
  BPF_JUMP(BPF_JMP|BPF_JSET|BPF_K,3|0100|01000|02000|020000000,1,0),
  BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ALLOW),
  BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),
  /* All other calls, including metadata mutation, cross-process prlimit,
   * sockets, IPC, fork/clone, signalling, ioctl and unknown future syscalls,
   * are denied. No deny-list holes become new capabilities. */
  BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM)
 };
 struct sock_fprog program={(unsigned short)(sizeof(filters)/sizeof(filters[0])),filters};
 if(prctl(PR_SET_NO_NEW_PRIVS,1,0,0,0)||prctl(PR_SET_SECCOMP,SECCOMP_MODE_FILTER,&program))failure();
 if(argc==2&&argv[1][0]=='-'&&argv[1][1]=='-'&&argv[1][2]=='p'){
  errno=0;if(socket(AF_INET,SOCK_STREAM,0)!=-1||errno!=EPERM)failure();puts("ISOLATION_SECCOMP_ENFORCED");return 0;
 }
 execv(argv[1],&argv[1]);failure();
}
