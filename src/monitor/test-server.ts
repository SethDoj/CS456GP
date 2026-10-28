import * as net from 'net'


function main() {
    const PORT = 5000;
    const HOST = '127.0.0.1'; 

    const client = new net.Socket();
    client.connect(PORT, HOST, ()=> {
        console.log("Connected to service on ", HOST, ":",PORT, ".");
    })
    client.on('data', (data)=> {
        console.log("Recieved ping:", data.toString());
        client.write(data.toString());
    })
}
main();