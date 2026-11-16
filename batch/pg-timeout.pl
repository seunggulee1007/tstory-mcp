#!/usr/bin/perl
# 사용법: pg-timeout.pl <초> <명령...>
# 명령을 새 프로세스 그룹에서 실행하고, 시간이 지나면 그룹 전체(자손 포함)를 TERM 후 KILL 한다.
# (GNU timeout 이 없는 macOS 용. npm 만 죽이고 tsx/agent-browser 가 남는 문제를 막는다.)
use strict;
use warnings;
use POSIX ();

my $secs = shift @ARGV;
die "사용법: pg-timeout.pl <초> <명령...>\n" unless defined $secs && @ARGV;

my $pid = fork();
die "fork 실패: $!\n" unless defined $pid;
if ($pid == 0) {
    setpgrp(0, 0);
    exec @ARGV or die "exec 실패: $!\n";
}
setpgrp($pid, $pid);    # 경쟁 상태 방지: 부모에서도 그룹을 지정 (실패해도 무시)

my $timed_out = 0;
$SIG{ALRM} = sub {
    $timed_out = 1;
    kill 'TERM', -$pid;
    select(undef, undef, undef, 3);
    kill 'KILL', -$pid;
};
$SIG{TERM} = $SIG{INT} = sub { kill 'KILL', -$pid; exit 143; };
alarm $secs;
waitpid($pid, 0);
alarm 0;
kill 'KILL', -$pid;     # 남은 자손 정리
exit 124 if $timed_out;
exit($? & 127 ? 128 + ($? & 127) : $? >> 8);
