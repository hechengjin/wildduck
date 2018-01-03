USERID='5a45de0ffbab254c597a8193'
INBOXID='5a45de0ffbab254c597a8194'
TRASH='5a45de0ffbab254c597a8196'
EMLPATH='/home/hechengjin/code/mail_server_new/mail_server/imap-core/test/fixtures'
basepath=$(cd `dirname $0`; pwd)
echo $USERID
echo $INBOXID
echo $basepath




curl --silent -XPOST "http://localhost:8080/users/$USERID/mailboxes/$TRASH/messages?unseen=true" \
	-H 'Content-type: message/rfc822' \
	-d "from: sender@example.com
to: receiver@example.com
subject: test1

hello 1
"


notExce(){
curl --silent -XPOST "http://localhost:8080/users/$USERID/mailboxes/$INBOXID/messages?unseen=false" \
	-H 'Content-type: message/rfc822' \
	--data-binary "$basepath/fixtures/fix2.eml"
echo "notExce"


curl --silent -XPOST "http://localhost:8080/users/$USERID/mailboxes/$INBOXID/messages?unseen=true" \
	-H 'Content-type: message/rfc822' \
	--data-binary "from: sender@example.com
to: receiver@example.com
subject: test6

hello 6
"
}


#运行方法:
#先执行一次：chmod +x myPrepare.sh
#再运行：sudo ./imap-core/test/myPrepare.sh

