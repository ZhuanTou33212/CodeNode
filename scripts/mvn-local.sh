#!/usr/bin/env bash
# CodeNode 本地构建入口：绕过 mvnw 的 dist 下载（网络受限），直接用本地 Maven 3.9.10 dist。
# 用法: scripts/mvn-local.sh <maven args...>   例如: scripts/mvn-local.sh test -Dtest=AgentSessionScopeTest
set -e
export JAVA_HOME="${JAVA_HOME:-E:\\CodeNode\\tools\\jdk-21.0.12+8}"
M2D="C:\\Users\\asus\\.m2\\wrapper\\dists\\apache-maven-3.9.10\\c420edeb14f9688d31a9d0c716a35be33c299d72b0941d215bce33cc6fa81815"
cd "$(dirname "$0")/.."
"$JAVA_HOME\\bin\\java" -classpath "$M2D\\boot\\plexus-classworlds-2.9.0.jar" \
  "-Dclassworlds.conf=$M2D\\bin\\m2.conf" \
  "-Dmaven.home=$M2D" \
  "-Dmaven.multiModuleProjectDirectory=$(pwd -W 2>/dev/null || pwd)" \
  org.codehaus.plexus.classworlds.launcher.Launcher "$@"
