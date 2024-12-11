import { useEffect, useRef, useState } from "react";
import io from "socket.io-client";

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_SERVICE_ROLE_KEY
);

function App() {
  const [socket, setSocket] = useState(null);
  const [friends, setFriends] = useState([]);
  const socketRef = useRef(null);
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const [isConnected, setIsConnected] = useState(true);
  const [userUUID, setUserUUID] = useState(''); // Default user ID
  const remoteUserUUIDRef = useRef(null);

  useEffect(()=>{
    const params = new URLSearchParams(window.location.search)
    const uuid = params.get('uuid')
    if(uuid) {
      setUserUUID(uuid)
    }
  }, [])

  const fetchUserFriends = async () => {
    try {
      const { data, error } = await supabase.rpc("get_friends_with_user_data", {
        user_uuid: userUUID,
      });

      if (error) {
        console.error("Error fetching friends:", error);
        return [];
      }

      console.log("My data...", data);

      // Get only friend_id where user is not the one going offline
      if (data) {
        setFriends(data);
      }
    } catch (err) {
      console.log(err);
    }
  };

  useEffect(() => {
    if (userUUID) {
      fetchUserFriends();
      console.log("User UUID: " + userUUID);
  
      const newSocket = io(`${import.meta.env.VITE_BACKEND_URI}?uuid=${userUUID}`);
      socketRef.current = newSocket;
  
      console.log("Connecting to socket...");
  
      // ICE Candidate Queue
      const iceCandidateQueue = [];
      const addIceCandidateSafely = async (candidate) => {
        if (peerConnectionRef.current && peerConnectionRef.current.remoteDescription) {
          try {
            await peerConnectionRef.current.addIceCandidate(candidate);
            console.log("Added ICE candidate successfully.");
          } catch (error) {
            console.error("Failed to add ICE candidate:", error);
          }
        } else {
          console.log("Queuing ICE candidate because remote description is not set.");
          iceCandidateQueue.push(candidate);
        }
      };
  
      const flushIceCandidateQueue = async () => {
        while (iceCandidateQueue.length) {
          const candidate = iceCandidateQueue.shift();
          await addIceCandidateSafely(candidate);
        }
      };
  
      const cleanup = () => {
        if (peerConnectionRef.current) {
          peerConnectionRef.current.close();
          peerConnectionRef.current = null;
          console.log("Peer connection closed.");
        }

  
        if (localVideoRef.current) {
          const tracks = localVideoRef.current.srcObject?.getTracks();
          tracks?.forEach((track) => track.stop());
          localVideoRef.current.srcObject = null;
          console.log("Local video tracks stopped.");
        }
  
        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = null;
          console.log("Remote video cleared.");
        }
      };
  
      // Setup socket listeners
      socketRef.current.on("connect", () => {
        console.log("Connected to server: ", newSocket.id);
      });
  
      socketRef.current.on("callDeclined", (data) => {
        console.log("Call was declined: ", data);
        alert("Call was declined.", data.message);
      });
  
      socketRef.current.on("callAccepted", (data) => {
        console.log("Call was accepted: ", data);
        startCall(data);
      });
  
      socketRef.current.on("answer", async ({ answer, from }) => {
        remoteUserUUIDRef.current = from;
        console.log("Answer received...", answer);
        try {
          await peerConnectionRef.current.setRemoteDescription(answer);
          console.log("Remote description set successfully.");
          flushIceCandidateQueue();
        } catch (error) {
          console.error("Error setting remote description:", error);
        }
      });
  
      socketRef.current.on("candidate", async ({ candidate }) => {
        addIceCandidateSafely(candidate);
      });
  
      const startCall = async (info) => {
        try {
          const pc = new RTCPeerConnection({
            iceServers: [
              { urls: "stun:stun.l.google.com:19302" },
              { urls: "turn:global.turn.twilio.com", username: "your-username", credential: "your-credential" },
            ],
          });
          peerConnectionRef.current = pc;
  
          const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
          localVideoRef.current.srcObject = stream;
  
          stream.getTracks().forEach((track) => pc.addTrack(track, stream));
  
          pc.onicecandidate = (event) => {
            if (event.candidate) {
              socketRef.current.emit("candidate", { to: info.to, candidate: event.candidate });
            }
          };
  
          pc.ontrack = (event) => {
            console.log("Receiving remote track...");
            remoteVideoRef.current.srcObject = event.streams[0];
          };
  
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socketRef.current.emit("offer", { from: info.from, to: info.to, offer });
          console.log("Offer sent.");
        } catch (error) {
          console.error("Error during call setup:", error);
        }
      };
  
      socketRef.current.on("offer", async (data) => {
        remoteUserUUIDRef.current = data.from;
        try {
          const pc = new RTCPeerConnection({
            iceServers: [
              { urls: "stun:stun.l.google.com:19302" },
              { urls: "turn:global.turn.twilio.com", username: "your-username", credential: "your-credential" },
            ],
          });
          peerConnectionRef.current = pc;
  
          const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
          localVideoRef.current.srcObject = stream;
  
          stream.getTracks().forEach((track) => pc.addTrack(track, stream));
  
          pc.onicecandidate = (event) => {
            if (event.candidate) {
              socketRef.current.emit("candidate", { candidate: event.candidate, to: data.from });
            }
          };
  
          pc.ontrack = (event) => {
            remoteVideoRef.current.srcObject = event.streams[0];
          };
  
          await pc.setRemoteDescription(data.offer);
          console.log("Remote offer description set.");
  
          flushIceCandidateQueue();
  
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socketRef.current.emit("answer", { answer, to: data.from, from: userUUID });
          console.log("Answer sent.");
        } catch (error) {
          console.error("Error handling offer:", error);
        }
      });
  
      socketRef.current.on("incomingCall", async (data) => {
        const response = true; // Automatically accept call for simplicity
        if (response) {
          console.log("Call accepted.");
          socketRef.current.emit("callAccepted", data);
        } else {
          console.log("Call declined.");
          socketRef.current.emit("callDeclined", data);
        }
      });
  
      socketRef.current.on("callEnded", () => {
        cleanup();
        
      });
  
      return cleanup;
    }
  }, [userUUID]);
  
  

  const callUser = (friend) => {
    console.log("Calling user: ", friend);
    socketRef.current.emit("callUser", {
      to: friend.user2,
      from: userUUID,
      fromUsername: friend.username,
    });
  };

  const endCall = () => {
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    localVideoRef.current.srcObject.getTracks().forEach((track) => track.stop());
    remoteVideoRef.current.srcObject.getTracks().forEach((track) => track.stop());
    setIsConnected(false);
  }

  const endThisCall = () => {
    socketRef.current.emit("endCall", {
      to: remoteUserUUIDRef.current,
    })
  }

  return (
    <div style={{}}>
      <h1>Kayber private call</h1>
      {isConnected && (
        <div style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
        }}>
          <button onClick={()=>endThisCall()}>End Call</button>
          <video ref={localVideoRef} autoPlay playsInline muted></video>
          <video ref={remoteVideoRef} autoPlay playsInline></video>
        </div>
      )}

        <>
          {friends.map((friend, i) => {
            return (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <h2>{friend.username}</h2>
                <button
                  style={{ marginLeft: "20px" }}
                  onClick={() => callUser(friend)}
                >
                  Call User
                </button>
              </div>
            );
          })}
        </>
    </div>
  );
}

export default App;
