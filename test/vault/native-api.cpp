// Test-only adapter for the exact bundled MMKV core. No production native code.
// Each invocation reopens files. trim mirrors RN MMKV 3.3.1's wrapper sequence.
#include "MMKV.h"
#include <fstream>
#include <iostream>
#include <string>
#include <sys/resource.h>
#include <sys/stat.h>
#include <signal.h>
#include <unistd.h>
#include <dlfcn.h>
#include <cerrno>
using std::string;
static unsigned shrinkFailures=0;
// Test-only failure injection into the unchanged linked core. No file is edited.
extern "C" int ftruncate(int fd, off_t length) {
 static auto real=(int(*)(int,off_t))dlsym(RTLD_NEXT,"ftruncate");
 struct stat st{};
 if(getenv("BIP02_FAIL_SHRINK") && !fstat(fd,&st) && length<st.st_size) {
   shrinkFailures++;errno=EIO;return -1;
 }
 return real(fd,length);
}
static string read(const char *path) {std::ifstream f(path,std::ios::binary);return string(std::istreambuf_iterator<char>(f),{});}
int main(int argc,char **argv) {
 if(argc<3)return 2;
 const string cmd=argv[1],dir=argv[2];
 if(cmd=="stat") {struct stat st{};if(stat((dir+"/mmkv.default").c_str(),&st)||!S_ISREG(st.st_mode))return 12;std::cout<<st.st_size;return 0;}
 MMKV::initializeMMKV(dir,MMKVLogNone);
#ifdef MMKV_ANDROID
 auto kv=MMKV::mmkvWithID("mmkv.default",mmkv::DEFAULT_MMAP_SIZE,MMKV_SINGLE_PROCESS);
#else
 auto kv=MMKV::mmkvWithID("mmkv.default",MMKV_SINGLE_PROCESS);
#endif
 if(!kv)return 3;
 string input;
 if(cmd=="set") {if(argc<5)return 2;input=read(argv[4]);}
 // Model an already inventoried instance before timing the mutation. trim still
 // explicitly clears this cache, matching the pinned React Native wrapper.
 kv->allKeys();
 signal(SIGXFSZ,SIG_IGN);
 if(argc>5) {auto cap=std::stoll(argv[5]);if(cap>0){struct rlimit limit{(rlim_t)cap,(rlim_t)cap};if(setrlimit(RLIMIT_FSIZE,&limit))return 4;}}
 // Optional progress marker for inside-native kill experiments (not a crash copy).
 if(const char *progress=getenv("BIP02_PROGRESS")){std::ofstream f(progress);f<<"native-operation\n";f.flush();}
 int result=0;
 if(cmd=="set"){if(!kv->set(input,string(argv[3])))result=11;}
 else if(cmd=="get"){string value;if(!kv->getString(string(argv[3]),value))result=10;else std::cout<<value;}
 else if(cmd=="keys"){for(auto &key:kv->allKeys())std::cout<<key<<'\n';}
 else if(cmd=="size")std::cout<<kv->actualSize();
 else if(cmd=="delete")kv->removeValueForKey(string(argv[3]));
 else if(cmd=="trim"){kv->clearMemoryCache();kv->trim();}
 else if(cmd=="clear")kv->clearAll(); // original implementation control only
 else return 2;
 kv->sync();MMKV::onExit();
 struct rusage usage{};getrusage(RUSAGE_SELF,&usage);
 std::cerr<<"SHRINK_FAILURES="<<shrinkFailures<<'\n';
#ifdef __APPLE__
 std::cerr<<"PEAK_BYTES="<<usage.ru_maxrss<<'\n';
#else
 std::cerr<<"PEAK_BYTES="<<usage.ru_maxrss*1024L<<'\n';
#endif
 return result;
}
